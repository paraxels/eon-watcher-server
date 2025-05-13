const express = require('express');
const { connectDB } = require('./services/database');
const blockchainService = require('./services/blockchain');
const scheduler = require('./utils/scheduler');
const ExistingWallet = require('./models/ExistingWallet');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Basic route
app.get('/', (req, res) => {
  res.json({ message: 'EON Watcher Server is running' });
});

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

// Start the server
async function startServer() {
  try {
    // Connect to MongoDB
    await connectDB();
    
    // Initialize blockchain service
    await blockchainService.init();
    
    // Start the scheduler
    scheduler.startJobs();
    
    // Start Express server
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
