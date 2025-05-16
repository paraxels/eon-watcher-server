const { ethers } = require('ethers');
const { Alchemy, Network, AlchemySubscription } = require('alchemy-sdk');
const ExistingWallet = require('../models/ExistingWallet');
const TransactionRecord = require('../models/TransactionRecord');
const blockchainService = require('./blockchain');
const priceFeed = require('./priceFeed');
const seasonGoalService = require('./seasonGoals');
require('dotenv').config();

class BlockchainWatcher {
  constructor() {
    // Configure Alchemy provider
    const alchemyApiKey = process.env.ALCHEMY_API_KEY || '';
    const usingAlchemy = !!alchemyApiKey;
    
    // Determine which RPC URL to use
    const baseRpcUrl = process.env.BASE_RPC_URL;
    const alchemyRpcUrl = process.env.ALCHEMY_BASE_RPC_URL || `https://base-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;
    
    const rpcUrl = usingAlchemy ? alchemyRpcUrl : baseRpcUrl;
    console.log(`Using RPC endpoint: ${usingAlchemy ? 'Alchemy (higher rate limits)' : 'Public RPC'}`);
    console.log(`Using RPC endpoint: ${rpcUrl}`);
    
    // Create the provider with improved settings for rate limiting
    this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
      polling: true,
      pollingInterval: 5000, // Poll every 5 seconds (reduced frequency)
      staticNetwork: true,   // Network won't change
      batchStallTime: 100,   // Gather requests for 100ms
      batchMaxSize: 5        // Maximum of 5 requests in a batch (reduced batch size)
    });
    
    // Initialize Alchemy SDK if API key is available
    if (usingAlchemy) {
      const alchemyConfig = {
        apiKey: alchemyApiKey,
        network: Network.BASE_MAINNET
      };
      this.alchemy = new Alchemy(alchemyConfig);
      console.log('Alchemy SDK initialized successfully');
    } else {
      console.log('No Alchemy API key provided, WebSocket monitoring disabled');
      this.alchemy = null;
    }

    this.watchedWallets = new Map(); // Map of address -> donation settings
    this.transactionQueue = [];
    this.isProcessing = false;
    this.lastProcessedBlock = 0;
    
    // Track processed transactions to avoid duplicates
    this.processedTransactions = new Set();
    
    // Maximum number of transactions to keep in the set (to prevent memory leaks)
    this.maxTrackedTransactions = 5000;
  }

  // Utility: Only log if there are watched wallets
  logWatched(msg, ...args) {
    if (this.watchedWallets && this.watchedWallets.size > 0) {
      console.log(msg, ...args);
    }
  }

  // Initialize the watcher service
  async init() {
    try {
      console.log('Initializing blockchain watcher...');
      
      // Get the LATEST block number from the chain just for reference
      const latestBlockNumber = await this.provider.getBlockNumber();
      console.log(`Current chain head is at block ${latestBlockNumber}`);
      
      // With WebSocket approach, we don't need to track blocks or determine starting points
      // but we'll store the current block number for reference
      this.lastProcessedBlock = latestBlockNumber;
      console.log(`Using WebSocket monitoring - will detect all new transactions in real-time`);
      console.log(`Current block: ${this.lastProcessedBlock}`);
      
      // Load initial set of wallets from database
      await this.refreshWatchedWallets();
      
      // EXPLICITLY LOG WHICH WALLETS WE ARE WATCHING
      const watchedWallets = Array.from(this.watchedWallets.keys());
      this.logWatched('\n🔍 EXPLICITLY WATCHING THESE WALLETS:');
      watchedWallets.forEach((wallet, i) => {
        this.logWatched(`  ${i+1}. ${wallet}`);
      });
      this.logWatched(''); // Empty line for readability
      
      // Set up transaction processing loop
      this.startProcessingLoop();
      
      // Set up wallet refresh loop
      this.startWalletRefreshLoop();
      
      // Set up blockchain monitoring for ETH transfers
      this.startBlockchainMonitoring();
      
      // Set up monitoring for ERC20 token transfers
      this.setupERC20Monitoring();
      
      // No longer using block scanning, relying on WebSockets exclusively
      console.log(`\n⚡ Using real-time WebSocket monitoring for transactions - no catch-up needed`);
      
      console.log('Blockchain watcher initialized successfully');
    } catch (error) {
      console.error('Error initializing blockchain watcher:', error);
      throw error;
    }
  }

  // Load/refresh wallets from MongoDB
  async refreshWatchedWallets() {
    try {
      this.logWatched('Refreshing watched wallets from database...');
      
      // Get all active wallet configurations from the database
      // Sort by timestamp in descending order to get the most recent records first
      const walletConfigs = await ExistingWallet.find({
        active: true,
        walletAddress: { $exists: true },
        target: { $exists: true },
        percentAmount: { $exists: true },
      }).sort({ timestamp: -1 });
      
      this.logWatched(`Found ${walletConfigs.length} wallet configurations`);
      
      // A set to track which wallets we've already processed
      // We only want the most recent configuration for each wallet
      const processedWallets = new Set();
      
      // Clear the current map
      this.watchedWallets.clear();
      
      // Process each wallet configuration
      for (const config of walletConfigs) {
        // Skip if no wallet address or not properly configured
        if (!config.walletAddress || !config.target || !config.percentAmount) {
          this.logWatched(`Skipping invalid config: ${config._id} - missing required fields`);
          continue;
        }
        
        // CRITICAL: Normalize the wallet address - ALWAYS use lowercase for consistency
        // This fixes issues with address comparison
        let walletAddress = config.walletAddress;
        
        // Ensure the address is properly formatted
        if (!walletAddress.startsWith('0x')) {
          walletAddress = '0x' + walletAddress;
          this.logWatched(`Adding 0x prefix to wallet address: ${walletAddress}`);
        }
        
        // Always convert to lowercase for consistency
        walletAddress = walletAddress.toLowerCase();
        
        // Skip if we've already processed this wallet
        if (processedWallets.has(walletAddress)) {
          this.logWatched(`Skipping duplicate config for wallet: ${walletAddress}`);
          continue;
        }
        
        // Mark this wallet as processed
        processedWallets.add(walletAddress);
        
        // Create a single configuration for this wallet
        const walletConfig = {
          id: config._id,
          target: config.target.toLowerCase(), // Normalize target address too
          percentAmount: config.percentAmount,
          authorized: config.authorized ? config.authorized.toLowerCase() : null, // Normalize authorized address
          network: config.network || 'base-sepolia', // Default to base-sepolia if not specified
          lastDonation: config.lastDonation || 0,
          timestamp: config.timestamp // Keep track of when this config was created
        };
        
        // Add to our watched wallets map with a single configuration
        this.watchedWallets.set(walletAddress, {
          walletAddress: walletAddress,
          configurations: [walletConfig] // Only use the most recent config
        });
        
        this.logWatched(`Now watching wallet ${walletAddress} with configuration from ${config.timestamp}`);
        this.logWatched(`   Donation: ${walletConfig.percentAmount}% to ${walletConfig.target}`);
      }
      
      this.logWatched(`Now watching ${this.watchedWallets.size} unique wallet(s)`);
      
      // Debug log to confirm which wallets are being watched
      this.logWatched('\n🔍 EXPLICITLY WATCHING THESE WALLETS:');
      let index = 1;
      for (const walletAddress of this.watchedWallets.keys()) {
        this.logWatched(`  ${index++}. ${walletAddress}`);
      }
      this.logWatched(''); // Empty line for readability
    } catch (error) {
      console.error('Error refreshing wallets:', error);
    }
  }

  // Start a loop to periodically refresh the wallet list
  startWalletRefreshLoop() {
    // Refresh the wallet list every 5 seconds
    setInterval(() => this.refreshWatchedWallets(), 5 * 1000);
  }

  // Start a loop to process the transaction queue
  startProcessingLoop() {
    // Process the queue every 5 seconds
    setInterval(() => this.processTransactionQueue(), 5 * 1000);
  }
  
  // Set up ERC20 transfer event monitoring
  setupERC20Monitoring() {
    console.log('Setting up ERC20 token transfer monitoring...');
    
    // The standard ERC20 Transfer event ABI
    const transferEventAbi = [
      'event Transfer(address indexed from, address indexed to, uint256 value)'
    ];
    
    // Common ERC20 tokens to monitor (add more as needed)
    const tokenAddresses = [
      process.env.USDC_CONTRACT_ADDRESS.toLowerCase(), // USDC
      '0x4200000000000000000000000000000000000006' // WETH on Base
    ];
    
    // Create an interface for decoding ERC20 Transfer events
    this.erc20Interface = new ethers.Interface(transferEventAbi);
    
    // Store token addresses for reference
    this.monitoredTokens = new Set(tokenAddresses);
    
    // Cache for token details to reduce RPC calls
    this.tokenMetadataCache = new Map();
    
    // Log information about what we're monitoring
    tokenAddresses.forEach(tokenAddress => {
      console.log(`Setting up monitoring for token at ${tokenAddress}`);
    });
    
    // Log watched wallets that will be monitored for token transfers
    const watchedWallets = Array.from(this.watchedWallets.keys());
    console.log(`Monitoring ${watchedWallets.length} wallets for ERC20 token transfers`);
    
    console.log('ERC20 token transfer monitoring set up successfully');
  }

  // Start monitoring the blockchain for transactions to watched wallets
  startBlockchainMonitoring() {
    console.log('Starting blockchain monitoring...');
    
    // Use WebSocket monitoring exclusively for better performance
    if (this.alchemy) {
      this.setupAlchemyWebsockets();
      console.log('Using WebSocket monitoring exclusively for better performance');
    } else {
      console.error('ERROR: Alchemy API key required for WebSocket monitoring!');
      console.error('Please add ALCHEMY_API_KEY to your .env file and restart the server.');
    }
    
    // Set up a polling strategy as a backup
    this.setupBlockPolling();
    
    console.log('Blockchain monitoring started');
  }
  
  // Set up a polling strategy to check for new blocks periodically
  // This is our PRIMARY mechanism  // Legacy method kept for compatibility but not used
  setupBlockPolling() {
    // Not using block polling anymore - using WebSocket monitoring exclusively
  }
  
  // Set up Alchemy WebSocket subscriptions for real-time transaction monitoring
  setupAlchemyWebsockets() {
    try {
      if (!this.alchemy) {
        console.log('Alchemy API not configured, skipping WebSocket setup.');
        return;
      }

      console.log('Setting up Alchemy WebSocket monitoring for watched wallets...');

      // Initialize our transaction processing queue
      this.wsTransactionQueue = [];
      this.isProcessingWsQueue = false;
      this.lastRequestTime = Date.now();
      
      const watchedAddresses = Array.from(this.watchedWallets.keys()).map(addr => addr.toLowerCase());

      if (watchedAddresses.length === 0) {
        console.log('No wallets to watch, skipping WebSocket setup.');
        return;
      }

      console.log(`Watching transactions for ${watchedAddresses.length} wallets:`);
      watchedAddresses.forEach(address => console.log(` - ${address}`));

      // Subscribe to all mined transactions to these addresses
      this.alchemy.ws.on(
        {
          method: "alchemy_minedTransactions",
          addresses: watchedAddresses.map(address => ({ to: address.toLowerCase() }))
        },
        (txData) => {
          console.log('Raw ETH transaction data:', JSON.stringify(txData, null, 2));
          this.handleMinedTransaction(txData);
        }
      );

      // For ERC20 monitoring, we'll also subscribe to transactions from any address to our token contracts
      // This will catch ERC20 transfers that might be missed otherwise
      const tokenAddresses = [
        process.env.USDC_CONTRACT_ADDRESS.toLowerCase(), // USDC
        '0x4200000000000000000000000000000000000006' // WETH on Base
      ];
      
      // Store token addresses for future reference
      this.monitoredTokens = new Set(tokenAddresses.map(addr => addr.toLowerCase()));
      
      // Subscribe to all transactions involving the token contracts
      this.alchemy.ws.on(
        {
          method: "alchemy_minedTransactions",
          addresses: tokenAddresses.map(address => ({ to: address.toLowerCase() }))
        },
        (txData) => {
          console.log('Raw token contract transaction data:', JSON.stringify(txData, null, 2));
          this.handleMinedTransaction(txData);
        }
      );
      
      console.log(`\n✅ Set up monitoring for transactions to ERC20 token contracts`);
      tokenAddresses.forEach(addr => console.log(` - ${addr}`));

      console.log('✅ Alchemy WebSocket subscriptions established successfully!');
      console.log('Now monitoring all incoming transactions to watched wallets in real-time.');
      console.log('Using rate-limited processing to prevent API throttling.');
    } catch (error) {
      console.error('Error setting up Alchemy WebSockets:', error);
    }
  }
  
  // Queue to store WebSocket transactions for processing with rate limiting
  wsTransactionQueue = [];
  isProcessingWsQueue = false;
  lastRequestTime = 0;
  requestDelay = 1000; // 1 second between requests to prevent rate limiting

  // Handle all mined transactions, only process if it's a watched wallet or an ERC20 transfer to a watched wallet
  async handleMinedTransaction(txData) {
    try {
      // The structure from Alchemy WebSocket has the transaction in txData.transaction
      const tx = txData.transaction || txData;
      
      const txHash = tx.hash?.toLowerCase();
      if (!txHash) {
        console.log(`Received transaction without hash, skipping`);
        return;
      }
      
      // Only log transactions relevant to watched wallets
      
      // Skip if we've already processed this transaction
      if (this.processedTransactions.has(txHash)) {
        console.log(`Transaction ${txHash.substring(0, 10)}... already processed, skipping.`);
        return;
      }
      
      // Add to processed transactions set to prevent duplicates
      this.processedTransactions.add(txHash);
      
      // Make sure we don't accumulate too many processed transactions in memory
      if (this.processedTransactions.size > this.maxTrackedTransactions) {
        // Remove oldest entries (approximate - sets don't maintain insertion order)
        const entriesToRemove = this.processedTransactions.size - this.maxTrackedTransactions;
        let count = 0;
        for (const hash of this.processedTransactions) {
          this.processedTransactions.delete(hash);
          count++;
          if (count >= entriesToRemove) break;
        }
      }
      
      // Log transaction details
      // Only log transactions for watched wallets
      
      // First, check if this is a direct ETH transfer to a watched wallet
      const to = tx.to ? tx.to.toLowerCase() : null;
      if (to && this.watchedWallets.has(to)) {
        console.log(`\n🎯 Detected ETH transfer to watched wallet ${to}`);
        // Process ETH transfer
        const timestamp = Math.floor(Date.now() / 1000);
        await this.checkTransaction(tx, timestamp);
      }
      
      // Regardless of direct match, also check for ERC20 transfers in the transaction logs
      try {
        const receipt = await this.getReceiptWithRetries(txHash);
        if (receipt && receipt.logs && receipt.logs.length > 0) {
          await this.processReceiptLogsForERC20(receipt, txHash);
        }
      } catch (receiptError) {
        console.error(`Error getting transaction receipt for ${txHash}:`, receiptError);
      }
    } catch (error) {
      console.error(`Error handling mined transaction:`, error);
    }
  }

  // Handle ERC20 Transfer events from WebSocket subscription
  async handleERC20TransferLog(log, tokenAddress) {
    try {
      if (!log || !log.topics || log.topics.length < 3) {
        console.log('Invalid log data received for ERC20 transfer');
        return;
      }

      const txHash = log.transactionHash?.toLowerCase();
      if (!txHash) {
        console.log('Log missing transaction hash, skipping');
        return;
      }

      // Skip if we've already processed this transaction
      if (this.processedTransactions.has(txHash)) {
        console.log(`ERC20 transaction ${txHash.substring(0, 10)}... already processed, skipping.`);
        return;
      }

      // Add to processed transactions set to prevent duplicates
      this.processedTransactions.add(txHash);

      // Extract the 'to' address from the second indexed parameter (topics[2])
      const to = '0x' + log.topics[2].substring(26).toLowerCase();
      
      // Extract value from data field
      const value = BigInt(log.data) || 0n;

      console.log(`\n✅ ERC20 TRANSFER WebSocket event detected:`);
      console.log(` - Token: ${tokenAddress}`);
      console.log(` - To: ${to}`);
      console.log(` - Value: ${value.toString()}`);

      // Determine token type (USDC or WETH)
      const usdcAddress = process.env.USDC_CONTRACT_ADDRESS.toLowerCase();
      const wethAddress = '0x4200000000000000000000000000000000000006'.toLowerCase();

      // Token type already defined above
            if (tokenAddress === usdcAddress) {
              // Maintain the value for compatibility
              tokenType = 'USDC';
      } else if (tokenAddress === wethAddress) {
        tokenType = 'WETH';
      } else {
        tokenType = 'UNKNOWN';
        console.log(`Unknown token type: ${tokenAddress}, skipping`);
        return;
      }

      // Get block timestamp for donation record
      const blockTimestamp = log.blockNumber ? 
        (await this.provider.getBlock(log.blockNumber)).timestamp : 
        Math.floor(Date.now() / 1000);

      // Process the ERC20 transfer using our existing processing logic
      await this.processValueTransfer(to, value, txHash, tokenType, blockTimestamp);
    } catch (error) {
      console.error(`Error handling ERC20 transfer log:`, error);
    }
  }

  // Process logs from a transaction receipt to find ERC20 transfers
  async processReceiptLogsForERC20(receipt, txHash) {
    try {
      // This is the standard ERC20 Transfer event topic
      const transferEventTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const watchedAddresses = Array.from(this.watchedWallets.keys()).map(addr => addr.toLowerCase());

      // Only examine logs for ERC20 transfers (logging suppressed)

      for (const log of receipt.logs) {
        // Skip any logs that don't have topics
        if (!log.topics || log.topics.length === 0) continue;
        
        // Log the token address we're checking
        const tokenAddress = log.address.toLowerCase();
        
        // Check if this log is from a token contract we're monitoring
        const isMonitoredToken = this.monitoredTokens && this.monitoredTokens.has(tokenAddress);
        if (!isMonitoredToken) {
          // console.log(`Skipping log from non-monitored token: ${tokenAddress}`);
          continue;
        }

        // Check if this is a Transfer event
        if (log.topics[0] === transferEventTopic && log.topics.length >= 3) {
          // Extract from address (remove padding from topic)
          const from = '0x' + log.topics[1].substring(26).toLowerCase();
          // Extract to address (remove padding from topic)
          const to = '0x' + log.topics[2].substring(26).toLowerCase();
          // Extract value from data field
          const value = BigInt(log.data) || 0n;

          // Check if recipient is watched without excessive logging
          
          // Only process if the recipient is a watched wallet
          const isWatched = this.watchedWallets.has(to);
          if (isWatched) {
            // Determine token type (USDC or WETH) before logging
            const usdcAddress = process.env.USDC_CONTRACT_ADDRESS.toLowerCase();
            const wethAddress = '0x4200000000000000000000000000000000000006'.toLowerCase();
            
            // Get token type based on contract address
            let tokenType = 'UNKNOWN';
            if (tokenAddress === usdcAddress) {
              tokenType = 'USDC';
            } else if (tokenAddress === wethAddress) {
              tokenType = 'WETH';
            } else {
              tokenType = 'ERC20';
            }
            
            console.log(`\n🎯 Detected ${tokenType} transfer to watched wallet ${to}!`);
            console.log(`Transaction details:\n - Hash: ${txHash}\n - From: ${from}\n - Value: ${value.toString()} ${tokenType}`);
            console.log(`\n✅ ERC20 TRANSFER to watched wallet detected:`);
            console.log(` - Token: ${tokenAddress}`);
            console.log(` - From: ${from}`);
            console.log(` - To: ${to}`);
            console.log(` - Value: ${value.toString()} (raw value)`);

            // tokenType already declared above
            if (tokenAddress === usdcAddress) {
              // Re-assign for consistency
              tokenType = 'USDC';
            } else if (tokenAddress === wethAddress) {
              tokenType = 'WETH';
            } else {
              tokenType = 'UNKNOWN';
              console.log(`Unknown token type: ${tokenAddress}, skipping`);
              continue;
            }

            // Get block timestamp for donation record
            const blockTimestamp = receipt.blockNumber ? 
                (await this.provider.getBlock(receipt.blockNumber)).timestamp : 
                Math.floor(Date.now() / 1000);

            console.log(`Processing ${tokenType} transfer to watched wallet ${to}`);
            // Process the ERC20 transfer using our existing processing logic
            await this.processValueTransfer(to, value, txHash, tokenType, blockTimestamp);
          }
        }
      }
    } catch (error) {
      console.error(`Error processing receipt logs for ERC20:`, error);
    }
  }

  // Start monitoring the blockchain for transactions to watched wallets
  startBlockchainMonitoring() {
    console.log('Starting blockchain monitoring...');
    
    // Use WebSocket monitoring exclusively for better performance
    if (this.alchemy) {
      this.setupAlchemyWebsockets();
      console.log('Using WebSocket monitoring exclusively for better performance');
    } else {
      console.error('ERROR: Alchemy API key required for WebSocket monitoring!');
      console.error('Please add ALCHEMY_API_KEY to your .env file and restart the server.');
    }
    
    // Set up a polling strategy as a backup
    this.setupBlockPolling();
    
    console.log('Blockchain monitoring started');
  }
  
  // Set up a polling strategy to check for new blocks periodically
  // This is our PRIMARY mechanism  // Legacy method kept for compatibility but not used
  setupBlockPolling() {
    // Not using block polling anymore - using WebSocket monitoring exclusively
  }
  
  // Set up Alchemy WebSocket subscriptions for real-time transaction monitoring
  setupAlchemyWebsockets() {
    try {
      if (!this.alchemy) {
        console.log('Alchemy API not configured, skipping WebSocket setup.');
        return;
      }

      console.log('Setting up Alchemy WebSocket monitoring for watched wallets...');

      // Initialize our transaction processing queue
      this.wsTransactionQueue = [];
      this.isProcessingWsQueue = false;
      this.lastRequestTime = Date.now();
      
      const watchedAddresses = Array.from(this.watchedWallets.keys()).map(addr => addr.toLowerCase());

      if (watchedAddresses.length === 0) {
        console.log('No wallets to watch, skipping WebSocket setup.');
        return;
      }

      console.log(`Watching transactions for ${watchedAddresses.length} wallets:`);
      watchedAddresses.forEach(address => console.log(` - ${address}`));

      // Subscribe to all mined transactions to these addresses
      this.alchemy.ws.on(
        {
          method: "alchemy_minedTransactions",
          addresses: watchedAddresses.map(address => ({ to: address.toLowerCase() }))
        },
        (txData) => {
          console.log('Raw ETH transaction data:', JSON.stringify(txData, null, 2));
          this.handleMinedTransaction(txData);
        }
      );

      // For ERC20 monitoring, we'll also subscribe to transactions from any address to our token contracts
      // This will catch ERC20 transfers that might be missed otherwise
      const tokenAddresses = [
        process.env.USDC_CONTRACT_ADDRESS.toLowerCase(), // USDC
        '0x4200000000000000000000000000000000000006' // WETH on Base
      ];
      
      // Store token addresses for future reference
      this.monitoredTokens = new Set(tokenAddresses.map(addr => addr.toLowerCase()));
      
      // Subscribe to all transactions involving the token contracts
      this.alchemy.ws.on(
        {
          method: "alchemy_minedTransactions",
          addresses: tokenAddresses.map(address => ({ to: address.toLowerCase() }))
        },
        (txData) => {
          console.log('Raw token contract transaction data:', JSON.stringify(txData, null, 2));
          this.handleMinedTransaction(txData);
        }
      );
      
      console.log(`\n✅ Set up monitoring for transactions to ERC20 token contracts`);
      tokenAddresses.forEach(addr => console.log(` - ${addr}`));

      console.log('✅ Alchemy WebSocket subscriptions established successfully!');
      console.log('Now monitoring all incoming transactions to watched wallets in real-time.');
      console.log('Using rate-limited processing to prevent API throttling.');
    } catch (error) {
      console.error('Error setting up Alchemy WebSockets:', error);
    }
  }
  
  // Queue to store WebSocket transactions for processing with rate limiting
  wsTransactionQueue = [];
  isProcessingWsQueue = false;
  lastRequestTime = 0;
  requestDelay = 1000; // 1 second between requests to prevent rate limiting

  // Handle all mined transactions, only process if it's a watched wallet or an ERC20 transfer to a watched wallet
  async handleMinedTransaction(txData) {
    try {
      // The structure from Alchemy WebSocket has the transaction in txData.transaction
      const tx = txData.transaction || txData;
      
      const txHash = tx.hash?.toLowerCase();
      if (!txHash) {
        console.log(`Received transaction without hash, skipping`);
        return;
      }
      
      // Only log transactions relevant to watched wallets
      
      // Skip if we've already processed this transaction
      if (this.processedTransactions.has(txHash)) {
        console.log(`Transaction ${txHash.substring(0, 10)}... already processed, skipping.`);
        return;
      }
      
      // Add to processed transactions set to prevent duplicates
      this.processedTransactions.add(txHash);
      
      // Make sure we don't accumulate too many processed transactions in memory
      if (this.processedTransactions.size > this.maxTrackedTransactions) {
        // Remove oldest entries (approximate - sets don't maintain insertion order)
        const entriesToRemove = this.processedTransactions.size - this.maxTrackedTransactions;
        let count = 0;
        for (const hash of this.processedTransactions) {
          this.processedTransactions.delete(hash);
          count++;
          if (count >= entriesToRemove) break;
        }
      }
      
      // Log transaction details
      // Only log transactions for watched wallets
      
      // First, check if this is a direct ETH transfer to a watched wallet
      const to = tx.to ? tx.to.toLowerCase() : null;
      if (to && this.watchedWallets.has(to)) {
        console.log(`\n🎯 Detected ETH transfer to watched wallet ${to}`);
        // Process ETH transfer
        const timestamp = Math.floor(Date.now() / 1000);
        await this.checkTransaction(tx, timestamp);
      }
      
      // Regardless of direct match, also check for ERC20 transfers in the transaction logs
      try {
        const receipt = await this.getReceiptWithRetries(txHash);
        if (receipt && receipt.logs && receipt.logs.length > 0) {
          await this.processReceiptLogsForERC20(receipt, txHash);
        }
      } catch (receiptError) {
        console.error(`Error getting transaction receipt for ${txHash}:`, receiptError);
      }
    } catch (error) {
      console.error(`Error handling mined transaction:`, error);
    }
  }

  // Process WebSocket transaction queue with rate limiting
  async processWsTransactionQueue() {
    if (this.isProcessingWsQueue || this.wsTransactionQueue.length === 0) {
      return;
    }
    
    this.isProcessingWsQueue = true;
    
    try {
      while (this.wsTransactionQueue.length > 0) {
        // Implement rate limiting - ensure delay between requests
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < this.requestDelay) {
          // Wait until we can make the next request
          const waitTime = this.requestDelay - timeSinceLastRequest;
          console.log(`Rate limiting: Waiting ${waitTime}ms before next request...`);
          await this.delay(waitTime);
        }
        
        // Get next transaction from queue
        const { tx, timestamp } = this.wsTransactionQueue.shift();
        const txHash = tx.hash;
        
        console.log(`Processing queued transaction: ${txHash.substring(0, 10)}...`);
        console.log(`Transaction details:`);
        console.log(` - From: ${tx.from}`);
        console.log(` - To: ${tx.to}`);
        console.log(` - Value: ${ethers.formatEther(tx.value || '0')} ETH`);
        
        // Update last request time
        this.lastRequestTime = Date.now();
        
        // Check if recipient is a watched wallet
        if (tx.to) {
          const recipient = tx.to.toLowerCase();
          if (this.watchedWallets.has(recipient)) {
            console.log(`✅ MATCH FOUND! Recipient ${recipient} is a watched wallet.`);
            console.log('DEBUG: About to call checkTransaction for transaction:', tx.hash);
            
            try {
              // Process this transaction with our existing logic
              console.log('DEBUG: Calling checkTransaction directly to verify it works');
              await this.checkTransaction(tx, timestamp);
              console.log('DEBUG: Returned from direct checkTransaction call');
            } catch (err) {
              console.error('DEBUG ERROR: Error during checkTransaction call:', err);
            }
          }
        }
        
        // For ERC20 transfers, we need to check the logs with retries and backoff
        try {
          // Wait before making another request to avoid rate limiting
          await this.delay(this.requestDelay);
          this.lastRequestTime = Date.now();
          
          // Get receipt with retries
          const receipt = await this.getReceiptWithRetries(txHash);
          
          if (receipt && receipt.logs) {
            // Process logs with rate limiting
            await this.processReceiptLogsWithRateLimiting(receipt, txHash);
          }
        } catch (receiptError) {
          console.error(`Failed to get receipt after retries:`, receiptError.message);
        }
        
        // Short delay between processing transactions
        await this.delay(this.requestDelay);
      }
    } catch (error) {
      console.error(`Error processing WebSocket transaction queue:`, error);
    } finally {
      this.isProcessingWsQueue = false;
      
      // If more transactions were added while processing, start again
      if (this.wsTransactionQueue.length > 0) {
        this.processWsTransactionQueue();
      }
    }
  }
  
  // Get transaction receipt with retries and exponential backoff
  async getReceiptWithRetries(txHash, attempts = 0) {
    try {
      return await this.provider.getTransactionReceipt(txHash);
    } catch (error) {
      // If rate limited and under max retries, wait and try again
      if (error.message.includes('429') || error.message.includes('rate limit') || 
          error.message.includes('exceeded maximum retry limit')) {
        
        if (attempts < this.maxRetries) {
          // Exponential backoff: 2^attempt * base delay
          const backoffDelay = Math.min(2 ** attempts * 1000, 10000); // Max 10 second delay
          console.log(`Rate limited getting receipt. Retrying in ${backoffDelay/1000}s... (Attempt ${attempts+1}/${this.maxRetries})`);
          
          await this.delay(backoffDelay);
          return this.getReceiptWithRetries(txHash, attempts + 1);
        }
      }
      
      // Rethrow if too many retries or different error
      throw error;
    }
  }
  
  // Execute a function with retries for rate limiting
  async processWithRetries(fn, attempts = 0) {
    try {
      return await fn();
    } catch (error) {
      // If rate limited and under max retries, wait and try again
      if (error.message.includes('429') || error.message.includes('rate limit') || 
          error.message.includes('exceeded maximum retry limit')) {
        
        if (attempts < this.maxRetries) {
          // Exponential backoff: 2^attempt * base delay
          const backoffDelay = Math.min(2 ** attempts * 1000, 10000); // Max 10 second delay
          console.log(`Rate limited. Retrying in ${backoffDelay/1000}s... (Attempt ${attempts+1}/${this.maxRetries})`);
          
          await this.delay(backoffDelay);
          return this.processWithRetries(fn, attempts + 1);
        }
      }
      
      // Rethrow if too many retries or different error
      throw error;
    }
  }
  
  // Process logs with rate limiting between each log
  async processReceiptLogsWithRateLimiting(receipt, txHash) {
    try {
      // ERC20 Transfer event signature
      const transferEventTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      
      // Check each log for Transfer events
      for (const log of receipt.logs) {
        try {
          // Check if this is a Transfer event (topic 0 is the event signature)
          if (log.topics[0] === transferEventTopic && log.topics.length >= 3) {
            // Ensure we don't exceed rate limits
            await this.delay(300); // 300ms pause between logs
            
            // Extract addresses (removing padding)
            const from = '0x' + log.topics[1].substring(26).toLowerCase();
            const to = '0x' + log.topics[2].substring(26).toLowerCase();
            
            // Extract value (data field)
            const value = BigInt(log.data) || 0n;
            
            // Check if recipient is a watched wallet
            if (this.watchedWallets.has(to)) {
              console.log(`✅ DETECTED ERC20 TRANSFER to watched wallet!`);
              console.log(` - Token: ${log.address}`);
              console.log(` - From: ${from}`);
              console.log(` - To: ${to}`);
              console.log(` - Value: ${value.toString()}`);
              
              // Process the ERC20 transfer with retry logic
              await this.processWithRetries(() => this.processERC20Transfer(log.address, from, to, value, txHash));
            }
          }
        } catch (logError) {
          console.error(`Error processing log:`, logError);
        }
      }
    } catch (error) {
      console.error(`Error processing receipt logs:`, error);
    }
  }
  
  // Process logs from a transaction receipt to find ERC20 transfers
  async processReceiptLogs(receipt, txHash) {
    try {
      // ERC20 Transfer event signature
      const transferEventTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      
      // Check each log for Transfer events
      for (const log of receipt.logs) {
        try {
          // Check if this is a Transfer event (topic 0 is the event signature)
          if (log.topics[0] === transferEventTopic && log.topics.length === 3) {
            // Extract addresses (remove padding and leading zeros)
            const from = '0x' + log.topics[1].substring(26);
            const to = '0x' + log.topics[2].substring(26);
            
            // Extract amount from data field
            const value = BigInt(log.data);
            
            console.log(`Detected Transfer event in transaction ${txHash}:`);
            console.log(`Token: ${log.address}`);
            console.log(`From: ${from}`);
            console.log(`To: ${to}`);
            console.log(`Value: ${value.toString()}`);
            
            // Process it as an ERC20 transfer
            await this.processERC20Transfer(log.address, from, to, value, txHash);
          }
        } catch (error) {
          console.error(`Error processing log in transaction ${txHash}:`, error);
        }
      }
    } catch (error) {
      console.error(`Error processing receipt logs:`, error);
    }
  }
  
  async saveState() {
    try {
      console.log(`Saving state: Last processed block = ${this.lastProcessedBlock}`);
      console.log(`Total tracked transactions: ${this.processedTransactions.size}`);
      // State saving logic goes here
    } catch (error) {
      console.error('Error saving state:', error);
    }
  }

  // Legacy method kept for compatibility but not used
  async processBlock(blockNumber) {
    // Block processing is disabled - using WebSocket monitoring exclusively
    // This method is kept for compatibility with existing code
    this.lastProcessedBlock = blockNumber;
  }

  // Check a transaction to see if it involves a watched wallet
  async checkTransaction(tx, blockTimestamp) {
    // Skip if no recipient or no value
    if (!tx.to || !tx.value) return;
    
    // Always normalize to lowercase for consistent comparison
    const recipient = tx.to.toLowerCase();
    const txHash = tx.hash ? tx.hash.toLowerCase() : null;
    
    // Use provided blockTimestamp or fall back to current time if not available
    const timestamp = blockTimestamp || Math.floor(Date.now() / 1000);
    
    // IMPORTANT: Skip if we've already processed this transaction
    // Note: Temporarily bypassing this check for testing purposes
    if (this.processedTransactions.has(txHash)) {
      console.log(`DEBUG: Transaction ${txHash} was already processed, but processing again for testing`);
      // Comment out return for testing purposes
      // return;
    } else {
      console.log(`DEBUG: Transaction ${txHash} has not been processed before`);
    }
    
    // Only thing that matters: Is the recipient a watched wallet?
    const isWatchedWallet = this.watchedWallets.has(recipient);
    
    // Enhanced logging to help with debugging
    if (tx.value.toString() !== '0') {
      console.log(`Checking tx ${txHash.substring(0, 10)}... to ${recipient.substring(0, 10)}... (${ethers.formatEther(tx.value)} ETH)`);
      console.log(`Is wallet watched? ${isWatchedWallet ? 'YES' : 'NO'}`);
    }
    
    // Skip if it's not a watched wallet
    if (!isWatchedWallet) return;
    
    console.log(`DEBUG: Starting processing of matched transaction ${txHash}`);
    
    // Mark this transaction as processed to avoid duplicate processing
    this.processedTransactions.add(txHash);
    console.log(`DEBUG: Added transaction ${txHash} to processed set`);
    
    // Check if we've exceeded our transaction tracking limit
    if (this.processedTransactions.size > this.maxTrackedTransactions) {
      // Get first N items to remove (oldest transactions)
      const itemsToRemove = this.processedTransactions.size - this.maxTrackedTransactions;
      let count = 0;
      for (const hash of this.processedTransactions) {
        this.processedTransactions.delete(hash);
        count++;
        if (count >= itemsToRemove) break;
      }
    }
    
    // Log details for watched wallet transactions
    console.log(`DEBUG: Detected funds received by watched wallet: ${recipient}`);
    console.log('DEBUG: Transaction hash:', txHash);
    console.log('DEBUG: Transaction data:', {
      hash: txHash,
      to: recipient,
      from: tx.from ? tx.from.toLowerCase() : 'unknown',
      value: tx.value ? tx.value.toString() : 'unknown'
    });
    
    try {
      console.log(`DEBUG: Entering try block for transaction ${txHash}`);
      // Get full transaction details with a proper .value property
      let txDetails = tx;
      
      // If the transaction has a hash but is missing detailed data,
      // fetch the full transaction data
      if (txHash && (!tx.value || !tx.from)) {
        console.log(`DEBUG: Fetching full transaction details for ${txHash}`);
        txDetails = await this.provider.getTransaction(txHash);
        if (!txDetails) {
          console.error(`DEBUG: Could not get transaction details for ${txHash}`);
          return;
        }
        console.log(`DEBUG: Successfully fetched full transaction details`);
      } else {
        console.log(`DEBUG: Using provided transaction details without fetching`);
      }
      
      console.log('DEBUG: Full transaction details:', {
        value: txDetails.value.toString(),
        from: txDetails.from ? txDetails.from.toLowerCase() : 'unknown',
        to: txDetails.to.toLowerCase()
      });
      
      console.log(`DEBUG: Attempting to get transaction receipt for ${txHash}...`);
      // Get transaction receipt to check if it was successful
      const receipt = await this.provider.getTransactionReceipt(txHash);
      console.log(`DEBUG: Got receipt response for ${txHash}:`, receipt ? 'Receipt found' : 'Receipt not found');
      
      // Skip failed transactions
      if (!receipt) {
        console.log(`DEBUG: Transaction ${txHash} receipt not found - transaction may still be pending`);
        return;
      } else if (receipt.status === 0) {
        console.log(`DEBUG: Transaction ${txHash} failed (status=0)`);
        return;
      }
      
      console.log(`DEBUG: Transaction ${txHash} succeeded with status=${receipt.status}! Processing donation...`);
      
      // All we care about is that a watched wallet received funds
      // Process the donation based on the wallet's configuration
      console.log(`DEBUG: Calling processValueTransfer for ${recipient} with value ${txDetails.value}`);
      await this.processValueTransfer(recipient, txDetails.value, txHash, 'ETH', timestamp);
      console.log(`DEBUG: Returned from processValueTransfer`);
    } catch (error) {
      console.error(`DEBUG: Error processing transaction ${txHash}:`, error);
    }
  }

  // Process an ERC20 token transfer
  async processERC20Transfer(tokenAddress, from, to, value, txHash) {
    const recipient = to.toLowerCase();
    txHash = txHash.toLowerCase();
    
    // IMPORTANT: Skip if we've already processed this transaction
    // Note: Temporarily bypassing this check for testing purposes
    if (this.processedTransactions.has(txHash)) {
      console.log(`DEBUG: Transaction ${txHash} was already processed, but processing again for testing`);
      // Comment out return for testing purposes
      // return;
    } else {
      console.log(`DEBUG: Transaction ${txHash} has not been processed before`);
    }
    
    // Check if the recipient is one of our watched wallets
    if (this.watchedWallets.has(recipient)) {
      console.log(`Detected ERC20 transfer to watched wallet: ${recipient}`);
      console.log(`Token: ${tokenAddress}, Amount: ${value.toString()}`);
      
      // Mark this transaction as processed to avoid duplicate processing
      this.processedTransactions.add(txHash);
      
      try {
        // Get token details (we need to know decimals for proper conversion)
        const tokenDecimals = await this.getTokenDecimals(tokenAddress);
        const tokenSymbol = await this.getTokenSymbol(tokenAddress);
        
        // For USDC-like tokens (6 decimals), we can use the value directly
        // For other tokens, convert to a USD value
        let usdcEquivalent;
        
        // Handle different tokens
        if (tokenAddress.toLowerCase() === process.env.USDC_CONTRACT_ADDRESS.toLowerCase()) {
          // It's already USDC, just use the value directly
          usdcEquivalent = value;
          // Safely format the USDC value using ethers.js formatUnits
          console.log(`Received ${ethers.formatUnits(value, tokenDecimals)} USDC`);
        } else if (tokenSymbol === 'WETH') {
          // For WETH, unwrap to ETH value and then convert to USDC
          // First adjust for decimal difference between WETH (18) and ETH (18)
          const ethEquivalent = value;
          usdcEquivalent = priceFeed.convertEthToUsdc(ethEquivalent);
          // Safely format the values using ethers.js formatUnits
          console.log(`Received ${ethers.formatUnits(value, tokenDecimals)} WETH = ${ethers.formatUnits(usdcEquivalent, 6)} USDC`);
        } else {
          // For other tokens, attempt to get a price but fallback to not processing if we can't
          console.log(`Unsupported token transfer: ${tokenSymbol}. Skipping.`);
          return;
        }
        
        // Process the donation based on the wallet's configuration
        // Pass the block timestamp from the current block we're processing
        const timestamp = Math.floor(Date.now() / 1000); // Default to current time
        await this.processValueTransfer(recipient, value, txHash, tokenSymbol, timestamp);
      } catch (error) {
        console.error(`Error processing ERC20 transfer: ${error.message}`);
      }
    }
  }

  // Get token decimals
  async getTokenDecimals(tokenAddress) {
    try {
      const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function decimals() view returns (uint8)'],
        this.provider
      );
      return await tokenContract.decimals();
    } catch (error) {
      console.error(`Error getting token decimals: ${error.message}`);
      return 18; // Default to 18 decimals (most ERC20 tokens)
    }
  }

  // Get token symbol
  async getTokenSymbol(tokenAddress) {
    try {
      const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function symbol() view returns (string)'],
        this.provider
      );
      return await tokenContract.symbol();
    } catch (error) {
      console.error(`Error getting token symbol: ${error.message}`);
      return 'UNKNOWN';
    }
  }

  // Process a value transfer (ETH or tokens) to a watched wallet
  async processValueTransfer(recipient, valueAmount, txHash, assetType, blockTimestamp) {
    // Get the transaction data to determine the original sender
    let transactionData;
    try {
      transactionData = await this.provider.getTransaction(txHash);
      if (!transactionData) {
        console.error(`Could not get transaction data for ${txHash}`);
        return;
      }
    } catch (error) {
      console.error(`Error getting transaction data: ${error.message}`);
      return;
    }
    
    const walletData = this.watchedWallets.get(recipient);
    
    // Skip if this wallet is not configured correctly
    if (!walletData || !walletData.configurations || walletData.configurations.length === 0) {
      console.log(`Wallet ${recipient} has no valid configurations`);
      return;
    }
    
    // Process each configuration for this wallet
    for (const config of walletData.configurations) {
      // Skip if missing critical configuration
      if (!config.target || !config.percentAmount) {
        continue;
      }
      
      const donationPercentage = config.percentAmount;
      
      // Skip invalid configurations
      if (!donationPercentage || donationPercentage <= 0) {
        console.log(`Skipping configuration with invalid percentage: ${donationPercentage}`);
        continue;
      }
      
      let usdcEquivalent, rawValue, usdcFormatted;
      
      if (assetType === 'ETH') {
        // Convert ETH to USDC for donation calculation
        usdcEquivalent = priceFeed.convertEthToUsdc(valueAmount);
        rawValue = ethers.formatEther(valueAmount);
        usdcFormatted = (Number(usdcEquivalent) / 1e6).toFixed(6);
        console.log(`Transaction value: ${rawValue} ETH = ${usdcFormatted} USDC`);
      } else if (assetType === 'USDC') {
        // Already in USDC, use directly
        usdcEquivalent = valueAmount;
        rawValue = (valueAmount / BigInt(1e6)).toString();
        usdcFormatted = Number(rawValue).toFixed(6);
        console.log(`Transaction value: ${usdcFormatted} USDC`);
      } else if (assetType === 'WETH') {
        // Same as ETH in value
        usdcEquivalent = priceFeed.convertEthToUsdc(valueAmount);
        rawValue = ethers.formatEther(valueAmount);
        usdcFormatted = (Number(usdcEquivalent) / 1e6).toFixed(6);
        console.log(`Transaction value: ${rawValue} WETH = ${usdcFormatted} USDC`);
      } else {
        // Unsupported asset type
        console.log(`Unsupported asset type: ${assetType}. Skipping.`);
        continue;
      }
      
      // Calculate donation amount in USDC based on percentage
    // Use proper BigInt for calculations to prevent type errors
    // USDC has 6 decimals
    
    // For Number-based calculation, we convert BigInt to Number first
    const usdcValue = Number(ethers.formatUnits(usdcEquivalent, 6));
    
    // Calculate donation amount both ways for precise measurement
    const donationAmountFloat = usdcValue * (donationPercentage / 100);
    const donationAmount = (usdcEquivalent * BigInt(donationPercentage)) / BigInt(100);
      
      console.log(`Calculated donation amount: ${ethers.formatUnits(donationAmount, 6)} USDC (${donationPercentage}%)`);
      console.log(`Float calculation: ${donationAmountFloat.toFixed(6)} USDC`);
      
      // NEVER skip donation - use the smallest possible USDC unit if needed
      // For very small donations, use float calculation and ensure at least 1 unit of USDC (0.000001)
      const SMALLEST_USDC_UNIT = 1n; // 1 unit = 0.000001 USDC (smallest possible unit)
      
      let finalDonationAmount;
      if (donationAmount > 0) {
        // If BigInt calculation gives non-zero value, use it
        finalDonationAmount = donationAmount;
      } else if (donationAmountFloat > 0) {
        // If percentage is non-zero but BigInt calculation gives zero,
        // use float calculation but ensure at least 1 unit of USDC
        const floatBasedAmount = BigInt(Math.floor(donationAmountFloat * 1e6));
        finalDonationAmount = floatBasedAmount > 0 ? floatBasedAmount : SMALLEST_USDC_UNIT;
        console.log(`⚠️ Rounding tiny donation up to smallest USDC unit (0.000001 USDC)`);
      } else {
        // If percentage is zero, no donation
        finalDonationAmount = 0n;
      }
      
      if (finalDonationAmount > 0) {
        try {
          // Check if donation would exceed season goal and adjust if needed
          console.log(`Checking season goal for ${recipient} before processing donation...`);
          const seasonCheck = await seasonGoalService.checkAndAdjustDonation(recipient, finalDonationAmount);
          
          // If season goal check indicates an adjustment is needed
          if (seasonCheck.needsAdjustment) {
            // Convert adjusted amount to BigInt
            const adjustedAmount = BigInt(seasonCheck.adjustedAmount);
            
            // If the adjusted amount is zero, season goal is already met
            if (adjustedAmount === 0n) {
              console.log(`⚠️ Season goal already met for wallet ${recipient}. Skipping donation.`);
              continue; // Skip this donation entirely
            }
            
            // Update the donation amount to the adjusted amount
            finalDonationAmount = adjustedAmount;
            console.log(`📊 Adjusted donation amount to ${ethers.formatUnits(adjustedAmount, 6)} USDC to meet season goal exactly`);
            
            // Log completion of goal if applicable
            if (seasonCheck.isGoalComplete) {
              console.log(`🎉 This donation completes the season goal for wallet ${recipient}!`);
            }
          }
          
          // Now queue the donation for processing with possibly adjusted amount
          this.queueDonation({
            from: recipient,                          // Watched wallet (sending the donation)
            originalFrom: transactionData.from,        // Original transaction sender
            originalTo: recipient,                    // Original transaction recipient (watched wallet)
            txHash: txHash,
            assetType: assetType,
            originalValue: valueAmount.toString(),
            usdcEquivalent: usdcEquivalent.toString(), // Store original USDC equivalent
            usdcFormatted: usdcFormatted,             // Store formatted USDC value
            to: config.target,                        // The donation recipient address from the config
            authorized: config.authorized,             // The contract authorized to spend tokens
            configId: config.id,                       // Config ID to update records later
            donationAmount: finalDonationAmount.toString(),
            percentAmount: donationPercentage,
            seasonInfo: seasonCheck.isGoalComplete ? {
              seasonId: seasonCheck.seasonId,
              isGoalComplete: true,
              totalDonated: seasonCheck.totalDonated,
              goalAmount: seasonCheck.goalAmount
            } : undefined,
            timestamp: blockTimestamp || Math.floor(Date.now() / 1000)  // Use block timestamp
          });
          
          console.log(`Queued donation of ${ethers.formatUnits(finalDonationAmount, 6)} USDC (${donationPercentage}%) to ${config.target}`);
        } catch (error) {
          console.error(`Error checking season goal for wallet ${recipient}:`, error);
          
          // Fall back to original donation amount if season check fails
          this.queueDonation({
            from: recipient,                          // Watched wallet (sending the donation)
            originalFrom: transactionData.from,        // Original transaction sender
            originalTo: recipient,                    // Original transaction recipient (watched wallet)
            txHash: txHash,
            assetType: assetType,
            originalValue: valueAmount.toString(),
            usdcEquivalent: usdcEquivalent.toString(), // Store original USDC equivalent
            usdcFormatted: usdcFormatted,             // Store formatted USDC value
            to: config.target,                        // The donation recipient address from the config
            authorized: config.authorized,             // The contract authorized to spend tokens
            configId: config.id,                       // Config ID to update records later
            donationAmount: finalDonationAmount.toString(),
            percentAmount: donationPercentage,
            timestamp: blockTimestamp || Math.floor(Date.now() / 1000)  // Use block timestamp
          });
          
          console.log(`Queued donation of ${ethers.formatUnits(finalDonationAmount, 6)} USDC (${donationPercentage}%) to ${config.target}`);
        }
      } else {
        console.log(`⚠️ Final donation amount is still zero. Transaction too small to generate a meaningful donation.`);
      }
    }
  }

  // Queue a donation for processing
  queueDonation(donationData) {
    this.transactionQueue.push(donationData);
    
    // Start processing the queue if not already processing
    if (!this.isProcessing) {
      this.processTransactionQueue();
    }
  }

  // Process the transaction queue
  async processTransactionQueue() {
    // Skip if already processing or queue is empty
    if (this.isProcessing || this.transactionQueue.length === 0) {
      return;
    }
    
    try {
      this.isProcessing = true;
      
      // Get the next donation from the queue
      const donation = this.transactionQueue.shift();
      
      // Skip if donation is null or missing txHash (shouldn't happen but be safe)
      if (!donation || !donation.txHash) {
        console.log(`Skipping invalid donation in queue`);
        return;
      }
      
      console.log(`Processing donation for transaction ${donation.txHash}...`);
      console.log(`Donation details: ${donation.from} -> ${donation.to}, Amount: ${donation.donationAmount} USDC`);
      
      // Calculate the original transaction USDC value
      // Original value is donationAmount * 100 / percentAmount
      const originalUsdcValue = donation.percentAmount > 0 ?
        (BigInt(donation.donationAmount) * BigInt(100) / BigInt(donation.percentAmount)).toString() :
        '0';
      
      // Create a transaction record - initially marked as pending
      const transactionRecord = new TransactionRecord({
        txHash: donation.txHash,
        originalTransaction: {
          from: donation.originalFrom,           // Sender of the original transaction
          to: donation.originalTo,              // Recipient of the original transaction (watched wallet)
          value: donation.originalValue,        // Original transaction value
          assetType: donation.assetType,        // Asset type (ETH, USDC, WETH)
          usdcValue: originalUsdcValue          // USDC equivalent in smallest unit
        },
        donation: {
          from: donation.from,                  // Donation sender (watched wallet)
          to: donation.to,                      // Donation recipient 
          amount: donation.donationAmount,      // USDC amount in smallest unit
          usdcValue: donation.donationAmount,   // USDC value in base units (smallest unit)
          percentAmount: donation.percentAmount,
          contractAddress: donation.authorized || process.env.EON_CONTRACT_ADDRESS
        },
        blockTimestamp: donation.timestamp,
        processedAt: Math.floor(Date.now() / 1000),
        configId: donation.configId,
        status: 'pending'
      });
      
      try {
        // First save the pending record
        await transactionRecord.save();
        console.log(`Created transaction record in database for ${donation.txHash}`);
        
        // Prepare donation data in the format expected by the blockchain service
        // The blockchain service expects arrays for batch processing
        const donationData = {
          froms: [donation.from.toLowerCase()],
          tos: [donation.to.toLowerCase()],
          donationTimes: [donation.timestamp],
          usdcAmounts: [donation.donationAmount],
          contractAddress: donation.authorized || process.env.EON_CONTRACT_ADDRESS
        };
        
        // Process the donation using the correct method (processDonations, not processDonation)
        const result = await blockchainService.processDonations(donationData);
        
        if (result.success) {
          console.log(`Successfully processed donation for transaction ${donation.txHash}`);
          console.log(`Transaction hash: ${result.transactionHash}`);
          
          // Update the transaction record with success status and transaction hash
          await TransactionRecord.findOneAndUpdate(
            { txHash: donation.txHash },
            {
              status: 'success',
              'donation.donationTxHash': result.transactionHash
            }
          );
          
          // Update the wallet configuration with the last donation timestamp
          const walletData = this.watchedWallets.get(donation.from.toLowerCase());
          if (walletData) {
            for (const config of walletData.configurations) {
              if (config.id.toString() === donation.configId.toString()) {
                config.lastDonation = donation.timestamp;
                
                // Also update in database
                await ExistingWallet.findByIdAndUpdate(config.id, {
                  lastDonation: donation.timestamp
                });
                
                console.log(`Updated last donation timestamp for wallet ${donation.from} to ${new Date(donation.timestamp * 1000).toISOString()}`);
                break;
              }
            }
          }
        } else {
          // Update the transaction record with failure status
          await TransactionRecord.findOneAndUpdate(
            { txHash: donation.txHash },
            {
              status: 'failed',
              error: result.message || 'Unknown error'
            }
          );
          console.error(`Failed to process donation: ${result.message}`);
        }
      } catch (error) {
        // Update the transaction record with failure status
        await TransactionRecord.findOneAndUpdate(
          { txHash: donation.txHash },
          {
            status: 'failed',
            error: error.message || 'Unknown error'
          }
        ).catch(err => console.error('Error updating transaction record:', err));
        
        console.error(`Error processing donation: ${error.message}`);
      }
    } finally {
      this.isProcessing = false;
      
      // Continue processing the queue if there are more items
      if (this.transactionQueue.length > 0) {
        await this.processTransactionQueue();
      }
    }
  }

  // Helper method to add a delay between operations
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Legacy method kept for compatibility but not used
  async catchUpMissedBlocks() {
    console.log('Block scanning disabled - using WebSocket monitoring exclusively');
    // No need to catch up on blocks since we're using WebSockets for real-time monitoring
  }
  
  // For debugging: check a specific transaction
  async checkSpecificTransaction(txHash) {
    if (!txHash) return;
    
    console.log(`Checking specific transaction: ${txHash}`);
    
    try {
      // Get transaction details
      const tx = await this.provider.getTransaction(txHash);
      if (!tx) {
        console.log(`Transaction not found: ${txHash}`);
        return;
      }
      
      console.log('Transaction found:', tx);
      
      // Process it
      await this.checkTransaction(tx);
      
      // Check for ERC20 transfers
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (receipt && receipt.logs) {
        // ERC20 Transfer event signature
        const transferEventTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
        
        for (const log of receipt.logs) {
          try {
            // Check if this is a Transfer event (topic 0 is the event signature)
            if (log.topics[0] === transferEventTopic && log.topics.length === 3) {
              // Extract addresses (remove padding and leading zeros)
              const from = '0x' + log.topics[1].substring(26);
              const to = '0x' + log.topics[2].substring(26);
              
              // Extract amount from data field
              const value = BigInt(log.data);
              
              console.log(`Detected Transfer event in transaction ${txHash}:`);
              console.log(`Token: ${log.address}`);
              console.log(`From: ${from}`);
              console.log(`To: ${to}`);
              console.log(`Value: ${value.toString()}`);
              
              // Process it as an ERC20 transfer
              await this.processERC20Transfer(log.address, from, to, value, txHash);
            }
          } catch (error) {
            console.error(`Error processing log in transaction ${txHash}:`, error);
          }
        }
      }
    } catch (error) {
      console.error(`Error checking transaction ${txHash}:`, error);
    }
  }
}

module.exports = new BlockchainWatcher();