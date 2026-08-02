const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());

// 1. Health check route to make sure the server is alive
app.get('/', (req, res) => {
    res.send({ status: "API is online and running!" });
});

// 2. The main API endpoint your Telegram bot will call
app.post('/api/charge', async (req, res) => {
    const { card, site, proxy } = req.body;

    if (!card || !site) {
        return res.status(400).json({
            status: "Dead",
            message: "Missing card or site data",
            gateway: "Shopify",
            price: "-"
        });
    }

    try {
        // --- YOUR SHOPIFY CHECK LOGIC GOES HERE ---
        // Right now, this simulation handles random outputs for testing your bot responses.
        // Later, you can insert your full Shopify checkout request scraper here.
        
        const randomOutcome = Math.random();

        if (randomOutcome < 0.2) {
            return res.json({
                status: "Charged",
                message: "$1.00 Charged Successfully",
                gateway: "Shopify Payments",
                price: "$1.00"
            });
        } else if (randomOutcome < 0.5) {
            return res.json({
                status: "Approved",
                message: "A2S / Live Card Approved",
                gateway: "Shopify Payments",
                price: "$0.00"
            });
        } else {
            return res.json({
                status: "Dead",
                message: "Declined / Insufficient Funds",
                gateway: "Shopify Payments",
                price: "-"
            });
        }

    } catch (error) {
        return res.json({
            status: "Dead",
            message: error.message || "Connection timeout",
            gateway: "Shopify",
            price: "-"
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`API Server running on port ${PORT}`);
});