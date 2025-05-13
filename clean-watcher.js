const { ethers } = require('ethers');
const ExistingWallet = require('./src/models/ExistingWallet');
const blockchainService = require('./src/services/blockchain');
const priceFeed = require('./src/services/priceFeed');
require('dotenv').config();

// Script to clean up and fix the watcher.js file
const fs = require('fs');
const path = require('path');

// Path to the original watcher.js file
const srcPath = path.join(__dirname, 'src', 'services', 'watcher.js');
const backupPath = path.join(__dirname, 'src', 'services', 'watcher.js.bak');

// Create a backup of the original file
console.log('Creating backup of original watcher.js...');
fs.copyFileSync(srcPath, backupPath);
console.log(`Backup created at: ${backupPath}`);

// Clean watcher.js contents
const cleanedContent = `const { ethers } = require('ethers');
const ExistingWallet = require('../models/ExistingWallet');
const blockchainService = require('./blockchain');
const priceFeed = require('./priceFeed');
require('dotenv').config();

class BlockchainWatcher {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
    this.watchedWallets = new Map(); // Map of address -> donation settings
    this.transactionQueue = [];
    this.isProcessing = false;
    this.lastProcessedBlock = 0;
  }

  // Initialize the watcher service
  async init() {
    try {
      console.log('Initializing blockchain watcher...');
      
      // Get the current block number to start watching from
      this.lastProcessedBlock = await this.provider.getBlockNumber();
      console.log(\`Starting to watch from block \${this.lastProcessedBlock}\`);
      
      // Load initial set of wallets from database
      await this.refreshWatchedWallets();
      
      // Set up transaction processing loop
      this.startProcessingLoop();
      
      // Set up wallet refresh loop
      this.startWalletRefreshLoop();
      
      // Set up blockchain monitoring for ETH transfers
      this.startBlockchainMonitoring();
      
      // Set up monitoring for ERC20 token transfers
      this.setupERC20Monitoring();
      
      // Check a specific transaction (for debugging)
      await this.checkSpecificTransaction('0x0953d32d2a5b6aea0654e14d259207347a4f1a58a6179262d5b487ea44b5825e');
      
      console.log('Blockchain watcher initialized successfully');
    } catch (error) {
      console.error('Error initializing blockchain watcher:', error);
      throw error;
    }
  }

  // Load/refresh wallets from MongoDB
  async refreshWatchedWallets() {
    try {
      console.log('Refreshing watched wallets from database...');
      
      // Get all active wallet configurations from the database
      // Sort by timestamp in descending order to get the most recent records first
      const walletConfigs = await ExistingWallet.find({
        active: true,
        walletAddress: { $exists: true },
        target: { $exists: true },
        percentAmount: { $exists: true },
      }).sort({ timestamp: -1 });
      
      console.log(\`Found \${walletConfigs.length} wallet configurations\`);
      
      // A set to track which wallets we've already processed
      // We only want the most recent configuration for each wallet
      const processedWallets = new Set();
      
      // Clear the current map
      this.watchedWallets.clear();
      
      // Process each wallet configuration
      for (const config of walletConfigs) {
        // Skip if no wallet address or not properly configured
        if (!config.walletAddress || !config.target || !config.percentAmount) {
          continue;
        }
        
        // Normalize the wallet address
        const walletAddress = config.walletAddress.toLowerCase();
        
        // Skip if we've already processed this wallet
        if (processedWallets.has(walletAddress)) {
          continue;
        }
        
        // Mark this wallet as processed
        processedWallets.add(walletAddress);
        
        // Create a single configuration for this wallet
        const walletConfig = {
          id: config._id,
          target: config.target,
          percentAmount: config.percentAmount,
          authorized: config.authorized, // Contract authorized to spend tokens
          network: config.network || 'base-sepolia', // Default to base-sepolia if not specified
          lastDonation: config.lastDonation || 0,
          timestamp: config.timestamp // Keep track of when this config was created
        };
        
        // Add to our watched wallets map with a single configuration
        this.watchedWallets.set(walletAddress, {
          walletAddress: walletAddress,
          configurations: [walletConfig] // Only use the most recent config
        });
        
        console.log(\`Now watching wallet \${walletAddress} with configuration from \${config.timestamp}\`);
      }
      
      console.log(\`Now watching \${this.watchedWallets.size} unique wallet(s)\`);
    } catch (error) {
      console.error('Error refreshing wallets:', error);
    }
  }

  // Start a loop to periodically refresh the wallet list
  startWalletRefreshLoop() {
    // Refresh the wallet list every 5 minutes
    setInterval(() => this.refreshWatchedWallets(), 5 * 60 * 1000);
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
    const erc20Interface = new ethers.Interface(transferEventAbi);
    
    // Set up a periodic check for ERC20 transfers since direct event subscription has issues in ethers v6
    console.log('Will poll for ERC20 transfer events every block');
    
    // Create Transfer event filter for each token
    tokenAddresses.forEach(tokenAddress => {
      console.log(\`Setting up monitoring for token at \${tokenAddress}\`);
      
      // Set up a filter for Transfer events where 'to' is any of our watched wallets
      // We'll check this filter manually when processing blocks
    });
    
    console.log('ERC20 token transfer monitoring set up successfully');
  }

  // Start monitoring the blockchain for new blocks
  startBlockchainMonitoring() {
    console.log('Starting blockchain monitoring...');
    
    // Listen for new blocks
    this.provider.on('block', async (blockNumber) => {
      try {
        // Don't process the same block twice
        if (blockNumber <= this.lastProcessedBlock) {
          return;
        }
        
        console.log(\`Processing new block: \${blockNumber}\`);
        await this.processBlock(blockNumber);
      } catch (error) {
        console.error(\`Error processing block \${blockNumber}:\`, error);
      }
    });
    
    // Set up a polling strategy as a backup
    this.setupBlockPolling();
    
    console.log('Blockchain monitoring started');
  }
  
  // Set up a polling strategy to check for new blocks periodically
  // This acts as a fallback in case the event listener misses blocks
  setupBlockPolling() {
    console.log('Setting up block polling as backup mechanism');
    
    // Check for new blocks every 15 seconds
    setInterval(async () => {
      try {
        const latestBlock = await this.provider.getBlockNumber();
        
        // If we've missed some blocks, process them
        if (latestBlock > this.lastProcessedBlock) {
          console.log(\`Polling detected \${latestBlock - this.lastProcessedBlock} new blocks\`);
          
          // Process each missed block, but limit to 10 at a time to avoid overwhelming the system
          const startBlock = this.lastProcessedBlock + 1;
          const endBlock = Math.min(latestBlock, startBlock + 9);
          
          for (let blockNumber = startBlock; blockNumber <= endBlock; blockNumber++) {
            console.log(\`Polling processing block: \${blockNumber}\`);
            await this.processBlock(blockNumber);
          }
        }
      } catch (error) {
        console.error('Error in block polling:', error);
      }
    }, 15 * 1000); // 15 seconds
  }
  
  // Process a specific block
  async processBlock(blockNumber) {
    try {
      // Don't process the same block twice
      if (blockNumber <= this.lastProcessedBlock) return;
      
      // Update for next time
      this.lastProcessedBlock = blockNumber;
      
      // Get the block with full transaction details
      const block = await this.provider.getBlockWithTransactions(blockNumber);
      if (!block || !block.transactions) {
        console.log(\`No transactions in block \${blockNumber}\`);
        return;
      }
      
      console.log(\`Found \${block.transactions.length} transactions in block \${blockNumber}\`);
      
      // Print out watched wallet addresses for debugging
      console.log('Currently watching these wallets:', Array.from(this.watchedWallets.keys()).join(', '));
      
      // Process each transaction in the block
      for (const tx of block.transactions) {
        // Check if this transaction involves any of our watched wallets
        if (tx.to) {
          const recipient = tx.to.toLowerCase();
          if (this.watchedWallets.has(recipient)) {
            console.log(\`Block \${blockNumber} - Found transaction to watched wallet: \${recipient} (hash: \${tx.hash})\`);
          }
        }
        
        await this.checkTransaction(tx);
      }
      
      // Update the last processed block
      this.lastProcessedBlock = blockNumber;
    } catch (error) {
      console.error(\`Error processing block \${blockNumber}:\`, error);
    }
  }

  // Check a transaction to see if it involves a watched wallet
  async checkTransaction(tx) {
    // Skip if no recipient or no value
    if (!tx.to || !tx.value) return;
    
    const recipient = tx.to.toLowerCase();
    const txHash = tx.hash ? tx.hash.toLowerCase() : null;
    
    // Only thing that matters: Is the recipient a watched wallet?
    const isWatchedWallet = this.watchedWallets.has(recipient);
    
    // Skip if it's not a watched wallet
    if (!isWatchedWallet) return;
    
    // Log details for watched wallet transactions
    console.log(\`Detected funds received by watched wallet: \${recipient}\`);
    console.log('Transaction hash:', txHash);
    console.log('Transaction data:', {
      hash: txHash,
      to: recipient,
      from: tx.from ? tx.from.toLowerCase() : 'unknown',
      value: tx.value ? tx.value.toString() : 'unknown'
    });
    
    try {
      // Get full transaction details with a proper .value property
      let txDetails = tx;
      
      // If the transaction has a hash but is missing detailed data,
      // fetch the full transaction data
      if (txHash && (!tx.value || !tx.from)) {
        txDetails = await this.provider.getTransaction(txHash);
        if (!txDetails) {
          console.error(\`Could not get transaction details for \${txHash}\`);
          return;
        }
      }
      
      console.log('Full transaction details:', {
        value: txDetails.value.toString(),
        from: txDetails.from ? txDetails.from.toLowerCase() : 'unknown',
        to: txDetails.to.toLowerCase()
      });
      
      // Get transaction receipt to check if it was successful
      const receipt = await this.provider.getTransactionReceipt(txHash);
      
      // Skip failed transactions
      if (!receipt || receipt.status === 0) {
        console.log(\`Transaction \${txHash} failed or is still pending\`);
        return;
      }
      
      console.log(\`Transaction \${txHash} succeeded! Processing donation...\`);
      
      // All we care about is that a watched wallet received funds
      // Process the donation based on the wallet's configuration
      await this.processValueTransfer(recipient, txDetails.value, txHash, 'ETH');
    } catch (error) {
      console.error(\`Error processing transaction \${txHash}:\`, error);
    }
  }

  // Process an ERC20 token transfer
  async processERC20Transfer(tokenAddress, from, to, value, txHash) {
    const recipient = to.toLowerCase();
    
    // Check if the recipient is one of our watched wallets
    if (this.watchedWallets.has(recipient)) {
      console.log(\`Detected ERC20 transfer to watched wallet: \${recipient}\`);
      console.log(\`Token: \${tokenAddress}, Amount: \${value.toString()}\`);
      
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
          console.log(\`Received \${value / BigInt(10**tokenDecimals)} USDC\`);
        } else if (tokenSymbol === 'WETH') {
          // For WETH, unwrap to ETH value and then convert to USDC
          // First adjust for decimal difference between WETH (18) and ETH (18)
          const ethEquivalent = value;
          usdcEquivalent = priceFeed.convertEthToUsdc(ethEquivalent);
          console.log(\`Received \${ethers.formatUnits(value, tokenDecimals)} WETH = \${usdcEquivalent / BigInt(1e6)} USDC\`);
        } else {
          // For other tokens, attempt to get a price but fallback to not processing if we can't
          console.log(\`Unsupported token transfer: \${tokenSymbol}. Skipping.\`);
          return;
        }
        
        // Process the donation based on the wallet's configuration
        await this.processValueTransfer(recipient, value, txHash, tokenSymbol);
      } catch (error) {
        console.error(\`Error processing ERC20 transfer: \${error.message}\`);
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
      console.error(\`Error getting token decimals: \${error.message}\`);
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
      console.error(\`Error getting token symbol: \${error.message}\`);
      return 'UNKNOWN';
    }
  }

  // Process a value transfer (ETH or tokens) to a watched wallet
  async processValueTransfer(recipient, valueAmount, txHash, assetType) {
    const walletData = this.watchedWallets.get(recipient);
    
    // Skip if this wallet is not configured correctly
    if (!walletData || !walletData.configurations || walletData.configurations.length === 0) {
      console.log(\`Wallet \${recipient} has no valid configurations\`);
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
        console.log(\`Skipping configuration with invalid percentage: \${donationPercentage}\`);
        continue;
      }
      
      let usdcEquivalent;
      
      if (assetType === 'ETH') {
        // Convert ETH to USDC for donation calculation
        usdcEquivalent = priceFeed.convertEthToUsdc(valueAmount);
        console.log(\`Transaction value: \${ethers.formatEther(valueAmount)} ETH = \${usdcEquivalent / BigInt(1e6)} USDC\`);
      } else if (assetType === 'USDC') {
        // Already in USDC, use directly
        usdcEquivalent = valueAmount;
        console.log(\`Transaction value: \${valueAmount / BigInt(1e6)} USDC\`);
      } else if (assetType === 'WETH') {
        // Same as ETH in value
        usdcEquivalent = priceFeed.convertEthToUsdc(valueAmount);
        console.log(\`Transaction value: \${ethers.formatEther(valueAmount)} WETH = \${usdcEquivalent / BigInt(1e6)} USDC\`);
      } else {
        // Unsupported asset type
        console.log(\`Unsupported asset type: \${assetType}. Skipping.\`);
        continue;
      }
      
      // Calculate donation amount in USDC based on percentage
      const donationAmount = (usdcEquivalent * BigInt(donationPercentage)) / BigInt(100);
      console.log(\`Calculated donation amount: \${donationAmount / BigInt(1e6)} USDC (\${donationPercentage}%)\`);
      
      if (donationAmount > 0) {
        // Queue the donation for processing
        this.queueDonation({
          from: recipient,
          txHash: txHash,
          assetType: assetType,
          originalValue: valueAmount.toString(),
          to: config.target,              // The recipient address from the config
          authorized: config.authorized,   // The contract authorized to spend tokens
          configId: config.id,             // Config ID to update records later
          donationAmount: donationAmount.toString(),
          percentAmount: donationPercentage,
          timestamp: Math.floor(Date.now() / 1000)
        });
        
        console.log(\`Queued donation of \${donationAmount / BigInt(1e6)} USDC (\${donationPercentage}%) to \${config.target}\`);
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
      
      console.log(\`Processing donation for transaction \${donation.txHash}...\`);
      
      try {
        // Process the donation
        const result = await blockchainService.processDonation(
          donation.from,
          donation.to,
          donation.donationAmount,
          donation.authorized
        );
        
        if (result.success) {
          console.log(\`Successfully processed donation for transaction \${donation.txHash}\`);
          
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
                
                break;
              }
            }
          }
        } else {
          console.error(\`Failed to process donation: \${result.error}\`);
        }
      } catch (error) {
        console.error(\`Error processing donation: \${error.message}\`);
      }
    } finally {
      this.isProcessing = false;
      
      // Continue processing the queue if there are more items
      if (this.transactionQueue.length > 0) {
        await this.processTransactionQueue();
      }
    }
  }

  // For debugging: check a specific transaction
  async checkSpecificTransaction(txHash) {
    if (!txHash) return;
    
    console.log(\`Checking specific transaction: \${txHash}\`);
    
    try {
      // Get transaction details
      const tx = await this.provider.getTransaction(txHash);
      if (!tx) {
        console.log(\`Transaction not found: \${txHash}\`);
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
              
              console.log(\`Detected Transfer event in transaction \${txHash}:\`);
              console.log(\`Token: \${log.address}\`);
              console.log(\`From: \${from}\`);
              console.log(\`To: \${to}\`);
              console.log(\`Value: \${value.toString()}\`);
              
              // Process it as an ERC20 transfer
              await this.processERC20Transfer(log.address, from, to, value, txHash);
            }
          } catch (error) {
            console.error(\`Error processing log in transaction \${txHash}:\`, error);
          }
        }
      }
    } catch (error) {
      console.error(\`Error checking transaction \${txHash}:\`, error);
    }
  }
}

module.exports = new BlockchainWatcher();`;

// Write the cleaned content to the watcher.js file
console.log('Writing cleaned watcher.js file...');
fs.writeFileSync(srcPath, cleanedContent);
console.log('Watcher.js file cleaned and fixed!');
