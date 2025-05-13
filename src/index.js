const { connectDB } = require('./services/database');
const blockchainService = require('./services/blockchain');
const priceFeed = require('./services/priceFeed');
const watcher = require('./services/watcher');
require('dotenv').config();

async function startWatcherService() {
  try {
    console.log('Starting EON Transaction Watcher Service...');
    
    // Connect to MongoDB to read wallet data
    await connectDB();
    console.log('Connected to MongoDB');
    
    // Initialize blockchain service
    await blockchainService.init();
    console.log('Blockchain service initialized');
    
    // Initialize price feed service
    await priceFeed.init();
    console.log('Price feed service initialized');
    
    // Start transaction watcher
    await watcher.init();
    console.log('Transaction watcher started');
    
    console.log('EON Transaction Watcher Service is running');
    
    // Keep the process running
    process.on('SIGINT', async () => {
      console.log('Shutting down...');
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to start watcher service:', error);
    process.exit(1);
  }
}

// Start the service
startWatcherService();
