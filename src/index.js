const { connectDB } = require('./services/database');
const blockchainService = require('./services/blockchain');
const priceFeed = require('./services/priceFeed');
const moralisWatcher = require('./services/moralisWatcher');
const { startExpressServer } = require('./server'); // Import the Express server
require('dotenv').config();

async function startWatcherService() {
  try {
    console.log('Starting EON Transaction Watcher Service...');
    
    // First, start the Express server so the webhook endpoint is active
    // This is CRITICAL - must happen before Moralis tries to verify the webhook
    console.log('Starting Express server...');
    const expressServer = await startExpressServer();
    console.log('Express server started successfully!');
    
    // Connect to MongoDB to read wallet data
    await connectDB();
    console.log('Connected to MongoDB');
    
    // Initialize blockchain service
    await blockchainService.init();
    console.log('Blockchain service initialized');
    
    // Initialize price feed service
    await priceFeed.init();
    console.log('Price feed service initialized');
    
    // Start Moralis transaction watcher
    await moralisWatcher.init();
    console.log('Moralis transaction watcher started');
    
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
