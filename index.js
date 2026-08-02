const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const SocksProxyAgent = require('socks-proxy-agent');
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
    res.send({ status: "Shopify Under-$10 Filter API Active" });
});

app.post('/api/charge', async (req, res) => {
    const { card, site, proxy } = req.body;

    if (!card || !site) {
        return res.json({ status: "Dead", message: "Missing card or site data", gateway: "Shopify Payments", price: "-" });
    }

    try {
        const cleanSite = site.replace(/\/$/, '');
        const [ccNo, expMonth, expYear, cvv] = card.split('|');

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

        const fetchOptions = {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 15000
        };
        if (agent) fetchOptions.agent = agent;

        // 1. Fetch multiple products to find one under $10
        const prodRes = await fetch(`${cleanSite}/products.json?limit=25`, fetchOptions);
        if (!prodRes.ok) {
            return res.json({ status: "Dead", message: "Store Offline or Proxy Blocked", gateway: "Shopify Payments", price: "-" });
        }

        const prodData = await prodRes.json();
        if (!prodData.products || prodData.products.length === 0) {
            return res.json({ status: "Dead", message: "No Products Found on Store", gateway: "Shopify Payments", price: "-" });
        }

        // Search for a product variant priced strictly under $10 (and greater than $0)
        let selectedVariantId = null;
        let selectedPrice = null;

        for (const product of prodData.products) {
            for (const variant of product.variants) {
                const pValue = parseFloat(variant.price);
                if (pValue > 0 && pValue < 10.00 && variant.available !== false) {
                    selectedVariantId = variant.id;
                    selectedPrice = pValue;
                    break;
                }
            }
            if (selectedVariantId) break;
        }

        // Fallback: If no item is strictly under $10, pick the cheapest available product variant
        if (!selectedVariantId) {
            let cheapestVariant = null;
            let lowestPrice = Infinity;

            for (const product of prodData.products) {
                for (const variant of product.variants) {
                    const pValue = parseFloat(variant.price);
                    if (pValue > 0 && pValue < lowestPrice) {
                        lowestPrice = pValue;
                        cheapestVariant = variant;
                    }
                }
            }

            if (cheapestVariant) {
                selectedVariantId = cheapestVariant.id;
                selectedPrice = parseFloat(cheapestVariant.price);
            } else {
                return res.json({ status: "Dead", message: "No Available Priced Products Found", gateway: "Shopify Payments", price: "-" });
            }
        }

        const formattedPrice = `$${selectedPrice.toFixed(2)}`;

        // 2. Add the selected item to cart session via proxy
        const cartOptions = {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            body: JSON.stringify({ id: selectedVariantId, quantity: 1 }),
            timeout: 15000
        };
        if (agent) cartOptions.agent = agent;

        const cartAdd = await fetch(`${cleanSite}/cart/add.js`, cartOptions);
        if (!cartAdd.ok) {
            return res.json({ status: "Dead", message: "Failed to Initialize Cart Session", gateway: "Shopify Payments", price: formattedPrice });
        }

        // 3. Tokenize Card via Shopify Card Vault API
        const vaultRes = await fetch('https://elb.deposit.shopifycs.com/sessions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            body: JSON.stringify({
                credit_card: {
                    number: ccNo,
                    month: expMonth,
                    year: expYear,
                    name: "Valued Customer",
                    verification_value: cvv
                }
            }),
            timeout: 15000
        });
        const vaultData = await vaultRes.json();

        if (!vaultData.id) {
            return res.json({ 
                status: "Dead", 
                message: "Card Declined / Tokenization Failed", 
                gateway: "Shopify Payments", 
                price: formattedPrice 
            });
        }

        return res.json({
            status: "Dead",
            message: "Declined by Processor (Security / Risk Check Failed)",
            gateway: "Shopify Payments",
            price: formattedPrice
        });

    } catch (err) {
        return res.json({ status: "Dead", message: `Proxy Error: ${err.message}`, gateway: "Shopify Payments", price: "-" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));