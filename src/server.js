const express = require('express');
const { connectDB } = require('./services/database');
const blockchainService = require('./services/blockchain');
const moralisWatcher = require('./services/moralisWatcher');
const scheduler = require('./utils/scheduler');
const ExistingWallet = require('./models/ExistingWallet');
const { router: webhookRoutes } = require('./routes/webhookRoutes');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({
  verify: (req, res, buf) => {
    // Make raw body available for webhook signature verification
    req.rawBody = buf;
  },
  limit: '10mb' // Increase payload size limit for large Moralis webhook data
}));

// Basic route
app.get('/', (req, res) => {
  res.json({ message: 'EON Watcher Server is running' });
});

// Direct Moralis webhook endpoint for verification
app.post('/api/webhooks/moralis-webhook', (req, res) => {
  console.log('Received webhook from Moralis:', req.body);
  
  // Always respond with 200 OK for webhook verification
  res.status(200).send('Webhook received');
  
  // If this is a real webhook event with data, process it
  if (req.body && req.body.streamId) {
    try {
      // Process the webhook data here
      console.log(`Processing webhook data for stream: ${req.body.streamId}`);
      
      // Import the webhook processing function
      const { processWebhookData } = require('./routes/webhookRoutes');
      
      // Process asynchronously
      processWebhookData(req.body).catch(error => {
        console.error('Error processing webhook data:', error);
      });
    } catch (error) {
      console.error('Error processing webhook data:', error);
    }
  }
});

// Register direct webhook route for Moralis at the path it's expecting
app.post('/webhook/moralis', (req, res) => {
  console.log('Received webhook from Moralis at /webhook/moralis:', req.body);
  
  // Always respond with 200 OK for webhook verification
  res.status(200).send('Webhook received');
  
  // If this is a real webhook event with data, process it
  if (req.body && req.body.streamId) {
    try {
      // Import the webhook processing function
      const { processWebhookData } = require('./routes/webhookRoutes');
      
      // Process asynchronously
      processWebhookData(req.body).catch(error => {
        console.error('Error processing webhook data:', error);
      });
    } catch (error) {
      console.error('Error processing webhook data:', error);
    }
  }
});

// Register other webhook routes
app.use('/api/webhooks', webhookRoutes);

// Get all wallets with donation settings
app.get('/api/donations/wallets', async (req, res) => {
  try {
    const wallets = await ExistingWallet.find({ 'donationSettings.amount': { $exists: true, $ne: null } });
    res.json(wallets);
  } catch (error) {
    console.error('Error getting wallets with donations:', error);
    res.status(500).json({ error: 'Failed to fetch wallets' });
  }
});

// Get donation status for a specific wallet
app.get('/api/donations/status/:address', async (req, res) => {
  try {
    const wallet = await ExistingWallet.findOne({ 
      address: req.params.address.toLowerCase() 
    });
    
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    
    // Get current allowance from blockchain
    const allowance = await blockchainService.checkAllowance(wallet.address);
    const balance = await blockchainService.checkBalance(wallet.address);
    
    // Format response
    const response = {
      address: wallet.address,
      allowance: allowance.toString(),
      balance: balance.toString(),
      lastDonation: wallet.lastDonation || 0,
      donationSettings: wallet.donationSettings,
      // Calculate when next donation is due
      nextDonationDue: wallet.lastDonation ? 
        scheduler.calculateNextDonationTime(wallet.lastDonation, wallet.donationSettings.frequency) : 
        'Ready for first donation'
    };
    
    res.json(response);
  } catch (error) {
    console.error('Error getting wallet donation status:', error);
    res.status(500).json({ error: 'Failed to fetch wallet status' });
  }
});

// Get pending donations (wallets that are due for donations)
app.get('/api/donations/pending', async (req, res) => {
  try {
    const donationService = require('./services/donation');
    const eligibleWallets = await donationService.getEligibleWallets();
    
    // Format response to include just the necessary info
    const pendingDonations = eligibleWallets.map(wallet => ({
      address: wallet.address,
      recipients: wallet.donationSettings.recipients,
      amount: wallet.donationSettings.amount,
      frequency: wallet.donationSettings.frequency,
      lastDonation: wallet.lastDonation || 0
    }));
    
    res.json(pendingDonations);
  } catch (error) {
    console.error('Error getting pending donations:', error);
    res.status(500).json({ error: 'Failed to fetch pending donations' });
  }
});

// Manually trigger donation processing
app.post('/api/process-donations', async (req, res) => {
  try {
    const result = await scheduler.triggerDonationJob();
    res.json({ message: 'Donation processing triggered', result });
  } catch (error) {
    console.error('Error triggering donation process:', error);
    res.status(500).json({ error: 'Failed to trigger donation process' });
  }
});

// Check wallet allowance
app.get('/api/allowance/:address', async (req, res) => {
  try {
    const allowance = await blockchainService.checkAllowance(req.params.address);
    res.json({ address: req.params.address, allowance: allowance.toString() });
  } catch (error) {
    console.error('Error checking allowance:', error);
    res.status(500).json({ error: 'Failed to check allowance' });
  }
});

// Function to start the Express server
async function startExpressServer() {
  return new Promise((resolve, reject) => {
    try {
      // Start Express server and get the server instance
      const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`=================================================`);
        console.log(`EXPRESS SERVER STARTED SUCCESSFULLY!`);
        console.log(`Server is running on port ${PORT}`);
        console.log(`URL: http://localhost:${PORT}`);
        console.log(`Make sure ngrok is forwarding to http://localhost:${PORT}`);
        console.log(`=================================================`);
        
        // Log simple success message without trying to access server.address()
        // which can sometimes be null right after starting
        console.log(`Server successfully bound to port ${PORT}`);
        
        resolve(server);
      });
      
      // Handle server errors
      server.on('error', (error) => {
        console.error('EXPRESS SERVER ERROR:', error);
        if (error.code === 'EADDRINUSE') {
          console.error(`Port ${PORT} is already in use! Choose a different port.`);
        }
        reject(error);
      });
    } catch (error) {
      console.error('Failed to start Express server:', error);
      reject(error);
    }
  });
}

// Export the Express app and server functions
module.exports = {
  app,
  startExpressServer
};
