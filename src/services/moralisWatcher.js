const { ethers } = require('ethers');
const ExistingWallet = require('../models/ExistingWallet');
const TransactionRecord = require('../models/TransactionRecord');
const blockchainService = require('./blockchain');
const priceFeed = require('./priceFeed');
const seasonGoalService = require('./seasonGoals');
const moralisService = require('./moralis');
require('dotenv').config();

class MoralisWatcher {
  constructor() {
    // Determine which RPC URL to use
    const rpcUrl = process.env.BASE_RPC_URL || process.env.ALCHEMY_BASE_RPC_URL;
    console.log(`Using RPC endpoint: ${rpcUrl}`);
    
    // Create the provider with improved settings for rate limiting
    this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
      polling: true,
      pollingInterval: 5000, // Poll every 5 seconds
      staticNetwork: true,   // Network won't change
      batchStallTime: 100,   // Gather requests for 100ms
      batchMaxSize: 5        // Maximum of 5 requests in a batch
    });
    
    // Store watched wallets and transaction info
    this.watchedWallets = new Map(); // Map of address -> donation settings
    this.transactionQueue = [];
    this.isProcessing = false;
    this.lastProcessedBlock = 0;
    
    // Track processed transactions to avoid duplicates
    this.processedTransactions = new Set();
    this.maxTrackedTransactions = 5000; // Prevent memory leaks
    
    // Track whether the watched wallets have been synced to Moralis
    this.walletsSyncedToMoralis = false;
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
      console.log('Initializing Moralis blockchain watcher...');
      
      // Get the latest block number from the chain for reference
      const latestBlockNumber = await this.provider.getBlockNumber();
      console.log(`Current chain head is at block ${latestBlockNumber}`);
      
      // Store the current block number for reference
      this.lastProcessedBlock = latestBlockNumber;
      
      // Load initial set of wallets from database
      await this.refreshWatchedWallets();
      
      // Log which wallets we are watching
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
      
      // Initialize Moralis stream for monitoring
      await this.setupMoralisStream();
      
      console.log('Moralis watcher initialized successfully');
      return true;
    } catch (error) {
      console.error('Error initializing Moralis watcher:', error);
      return false;
    }
  }

  // Load/refresh wallets from MongoDB
  async refreshWatchedWallets() {
    try {
      console.log('Refreshing watched wallets from database...');
      
      // Fetch all wallets with donation settings
      const wallets = await ExistingWallet.find({
        $or: [
          // Support original format with donationSettings
          {'donationSettings.amount': { $exists: true, $ne: null }},
          // Support newer format with direct fields
          {dollarAmount: { $exists: true, $ne: null }, percentAmount: { $exists: true, $ne: null }}
        ],
        active: true // Only get active wallets
      });
      
      console.log(`Found ${wallets.length} wallets with donation settings`);
      
      // Create a new map with the updated wallets
      const updatedWallets = new Map();
      const processedWallets = new Set();
      
      for (const wallet of wallets) {
        // Get wallet address, handle both old and new formats
        let walletAddress = wallet.walletAddress || wallet.address;
        
        // Skip wallets without a valid address
        if (!walletAddress) {
          console.log('Skipping wallet with missing address:', wallet._id);
          continue;
        }
        
        // Add 0x prefix if missing
        if (!walletAddress.startsWith('0x')) {
          walletAddress = '0x' + walletAddress;
          console.log(`Adding 0x prefix to wallet address: ${walletAddress}`);
        }
        
        // Always convert to lowercase for consistency
        walletAddress = walletAddress.toLowerCase();
        
        // Skip if we've already processed this wallet
        if (processedWallets.has(walletAddress)) {
          console.log(`Skipping duplicate config for wallet: ${walletAddress}`);
          continue;
        }
        
        // Mark this wallet as processed
        processedWallets.add(walletAddress);
        
        // Determine donation settings based on the wallet format
        let walletConfig;
        
        if (wallet.donationSettings && Array.isArray(wallet.donationSettings)) {
          // Original format with donationSettings array
          walletConfig = {
            configurations: wallet.donationSettings.map(setting => ({
              id: wallet._id.toString(),
              target: setting.target || process.env.DEFAULT_DONATION_TARGET,
              percentAmount: setting.amount,
              authorized: setting.authorized,
              lastDonation: wallet.lastDonation || 0
            })),
            lastDonation: wallet.lastDonation || 0
          };
        } else if (wallet.donationSettings && wallet.donationSettings.amount) {
          // Original format with donationSettings object
          walletConfig = {
            configurations: [{
              id: wallet._id.toString(),
              target: wallet.donationSettings.target || process.env.DEFAULT_DONATION_TARGET,
              percentAmount: wallet.donationSettings.amount,
              authorized: wallet.donationSettings.authorized,
              lastDonation: wallet.lastDonation || 0
            }],
            lastDonation: wallet.lastDonation || 0
          };
        } else {
          // New format with direct fields
          walletConfig = {
            configurations: [{
              id: wallet._id.toString(),
              target: wallet.target || process.env.DEFAULT_DONATION_TARGET || process.env.EON_CONTRACT_ADDRESS,
              percentAmount: wallet.percentAmount,
              authorized: wallet.authorized || process.env.EON_CONTRACT_ADDRESS,
              lastDonation: wallet.lastDonation || 0
            }],
            lastDonation: wallet.lastDonation || 0
          };
        }
        
        // Store wallet configuration for easy access
        updatedWallets.set(walletAddress, walletConfig);
        
        // Log wallet configuration for debugging
        const config = walletConfig.configurations[0];
        console.log(`Configured wallet ${walletAddress}:`);
        console.log(`   Donation: ${config.percentAmount}% to ${config.target}`);
      }
      
      // Log any changes in the watched wallets
      const oldCount = this.watchedWallets ? this.watchedWallets.size : 0;
      const newCount = updatedWallets.size;
      
      if (oldCount !== newCount) {
        console.log(`Watched wallets count changed: ${oldCount} -> ${newCount}`);
      }
      
      // Update the wallets
      this.watchedWallets = updatedWallets;
      
      // Log which wallets we are watching
      const watchedWallets = Array.from(this.watchedWallets.keys());
      console.log('\n🔍 EXPLICITLY WATCHING THESE WALLETS:');
      watchedWallets.forEach((wallet, i) => {
        console.log(`  ${i+1}. ${wallet}`);
      });
      console.log(''); // Empty line for readability
      
      // If wallets have changed and we're already connected to Moralis, update the watch list
      if (this.walletsSyncedToMoralis && (oldCount !== newCount)) {
        await this.syncWatchedWalletsToMoralis();
      }
      
      return true;
    } catch (error) {
      console.error('Error refreshing watched wallets:', error);
      return false;
    }
  }

  // Start a loop to periodically refresh the wallet list
  startWalletRefreshLoop() {
    // Refresh wallets every 5 minutes
    const refreshInterval = 5 * 60 * 1000; // 5 minutes in milliseconds
    
    console.log(`Wallet refresh loop started (every 5 minutes)`);
    
    setInterval(async () => {
      try {
        await this.refreshWatchedWallets();
      } catch (error) {
        console.error('Error in wallet refresh loop:', error);
      }
    }, refreshInterval);
  }

  // Start a loop to process the transaction queue
  startProcessingLoop() {
    console.log('Transaction processing loop started');
    
    // Process the queue every 10 seconds
    setInterval(async () => {
      try {
        if (this.transactionQueue.length > 0 && !this.isProcessing) {
          await this.processTransactionQueue();
        }
      } catch (error) {
        console.error('Error in transaction processing loop:', error);
        this.isProcessing = false; // Reset the flag in case of error
      }
    }, 10000); // Check every 10 seconds
  }

  // Setup Moralis stream for monitoring
  async setupMoralisStream() {
    try {
      console.log('Setting up Moralis stream for blockchain monitoring...');
      
      // Initialize Moralis
      await moralisService.init();
      
      // Get the webhook URL from environment
      const webhookUrl = process.env.MORALIS_WEBHOOK_URL;
      if (!webhookUrl) {
        throw new Error('MORALIS_WEBHOOK_URL is not set in environment variables');
      }
      console.log(`Using webhook URL from environment: ${webhookUrl}`);
      
      // Check if we already have a stream ID in environment or from moralisService
      let streamId = process.env.MORALIS_STREAM_ID || moralisService.streamId;
      
      if (streamId) {
        console.log(`Using existing Moralis stream ID: ${streamId}`);
        
        // Verify the stream is active
        const isValid = await moralisService.verifyStream();
        if (isValid) {
          console.log(`Verified stream ID: ${moralisService.streamId}`);
          
          // Update stream settings to ensure we capture all transactions
          // Using only features available on the free plan
          await moralisService.updateStreamSettings({
            webhookUrl,
            includeNativeTxs: true,
            includeContractLogs: true,
            includeInternalTxs: false // Not using includeAllTxLogs as it requires a paid plan
          });
          console.log('Updated stream settings');
        } else {
          // Stream not found or invalid, create a new one
          streamId = await moralisService.createStream(webhookUrl, 'EON Transaction Watcher');
          console.log(`Created new Moralis stream: ${streamId}`);
        }
      } else {
        // No existing stream, create a new one
        streamId = await moralisService.createStream(webhookUrl, 'EON Transaction Watcher');
        console.log(`Created new Moralis stream: ${streamId}`);
        
        // After creation, update the stream settings
        if (streamId) {
          await moralisService.updateStreamSettings({
            includeNativeTxs: true,
            includeContractLogs: true,
            includeInternalTxs: false
            // Not using includeAllTxLogs as it requires a paid plan
          });
          console.log('Configured stream settings for transaction monitoring');
        }
      }
      
      // If we have a valid stream ID, sync our watched wallets
      if (moralisService.streamId) {
        // Sync wallets to Moralis
        await this.syncWatchedWalletsToMoralis();
        console.log('Moralis stream setup completed successfully');
        return true;
      } else {
        throw new Error('Failed to create or verify Moralis stream');
      }
    } catch (error) {
      console.error('Error setting up Moralis stream:', error);
      return false;
    }
  }

  // Sync watched wallets to Moralis
  async syncWatchedWalletsToMoralis() {
    try {
      const wallets = Array.from(this.watchedWallets.keys());
      console.log(`Syncing ${wallets.length} watched wallets to Moralis...`);
      
      // Check if we have a valid stream ID from moralisService
      if (!moralisService.streamId) {
        console.error('Cannot sync wallets: No valid Moralis stream ID');
        return false;
      }
      
      // Update the stream with the watched wallets
      console.log(`Adding ${wallets.length} addresses to Moralis stream ${moralisService.streamId}`);
      
      // Add the addresses to the stream using the available method
      const success = await moralisService.addWalletAddresses(wallets);
      
      if (success) {
        this.walletsSyncedToMoralis = true;
        console.log(`Successfully synced ${wallets.length} wallets to Moralis`);
        return true;
      } else {
        console.error('Failed to add wallet addresses to Moralis stream');
        return false;
      }
    } catch (error) {
      console.error('Error syncing watched wallets to Moralis:', error);
      return false;
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
        this.isProcessing = false;
        return;
      }
      
      console.log(`Processing donation for transaction ${donation.txHash}...`);
      console.log(`Donation details: ${donation.from} -> ${donation.to}, Amount: ${donation.donationAmount} USDC`);
      
      // TRIPLE-CHECK that this transaction hasn't already been processed
      // This is a critical check to prevent multiple donations from the same transaction
      if (this.processedTransactions.has(donation.txHash)) {
        console.log(`DUPLICATE PREVENTION: Transaction ${donation.txHash} already processed, skipping entirely`);
        this.isProcessing = false;
        return;
      }
      
      try {
        // Create a transaction record - initially marked as pending
        const transactionRecord = new TransactionRecord({
          txHash: donation.txHash,
          originalTransaction: {
            from: donation.originalFrom,           // Sender of the original transaction
            to: donation.originalTo,              // Recipient of the original transaction (watched wallet)
            value: donation.originalValue,        // Original transaction value
            assetType: donation.assetType,        // Asset type (ETH, USDC, WETH)
            usdcValue: donation.usdcEquivalent,   // USDC equivalent in smallest unit
            txHash: donation.txHash              // Original transaction hash
          },
          donation: {
            from: donation.from,                  // Donation sender (watched wallet)
            to: donation.to,                      // Donation recipient (configured target)
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
        
        // First save the pending record
        await transactionRecord.save();
        console.log(`Created transaction record in database for ${donation.txHash}`);
        
        // Check if donation would exceed season goal and adjust if needed
        console.log(`Checking season goal for ${donation.to} before processing donation...`);
        const seasonCheck = await seasonGoalService.checkAndAdjustDonation(donation.to, BigInt(donation.donationAmount));
        
        // If season goal check indicates an adjustment is needed
        if (seasonCheck && seasonCheck.needsAdjustment) {
          // Convert adjusted amount to BigInt
          const adjustedAmount = BigInt(seasonCheck.adjustedAmount);
          
          // If the adjusted amount is zero, season goal is already met
          if (adjustedAmount === 0n) {
            console.log(`⚠️ Season goal already met for wallet ${donation.to}. Skipping donation.`);
            await TransactionRecord.findOneAndUpdate(
              { txHash: donation.txHash },
              {
                status: 'failed',
                error: 'Season goal is already met'
              }
            );
            this.isProcessing = false;
            return;
          }
          
          // Update the donation amount to the adjusted amount
          const updatedDonationAmount = adjustedAmount;
          console.log(`📊 Adjusted donation amount to ${ethers.formatUnits(updatedDonationAmount, 6)} USDC to meet season goal exactly`);
          
          // Log completion of goal if applicable
          if (seasonCheck.isGoalComplete) {
            console.log(`🎉 This donation completes the season goal for wallet ${donation.to}!`);
          }
          
          // Update the transaction record with adjusted amount
          await TransactionRecord.findOneAndUpdate(
            { txHash: donation.txHash },
            {
              status: 'success',
              'donation.donationTxHash': updatedDonationAmount.toString(),
              'donation.amount': updatedDonationAmount.toString()
            }
          );
          
          // Update the wallet's last donation timestamp
          for (const [address, config] of this.watchedWallets.entries()) {
            if (address === donation.from.toLowerCase()) {
              // Update the last donation timestamp
              await ExistingWallet.findOneAndUpdate(
                { walletAddress: address },
                { lastDonation: donation.timestamp }
              );
              
              console.log(`Updated last donation timestamp for wallet ${donation.from}`);
              break;
            }
          }
        } else {
          // Prepare donation data in the format expected by the blockchain service
          // The blockchain service expects arrays for batch processing
          const donationData = {
            froms: [donation.from.toLowerCase()],
            tos: [donation.to.toLowerCase()],
            donationTimes: [donation.timestamp],
            usdcAmounts: [seasonCheck && seasonCheck.needsAdjustment ? 
              seasonCheck.adjustedAmount : 
              donation.donationAmount],
            contractAddress: donation.authorized || process.env.EON_CONTRACT_ADDRESS
          };

          console.log(`Processing donation for transaction ${donation.txHash}...`);
          console.log(`Donation details: ${donation.from} -> ${donation.to}, Amount: ${donationData.usdcAmounts[0]} USDC`);

          // Process the donation
          const donationResult = await blockchainService.processDonations(donationData);
          if (donationResult.success) {
            console.log(`Successfully processed donation of ${ethers.formatUnits(donationData.usdcAmounts[0], 6)} USDC from ${donation.from} to ${donation.to}`);
            
            // If this was an adjusted donation (less than the original amount), mark the season as complete
            if (donationData.usdcAmounts[0] !== donation.donationAmount) {
              console.log(`Donation was adjusted from ${donation.donationAmount} to ${donationData.usdcAmounts[0]} - marking season as complete`);
              const seasonId = donation.seasonInfo?.seasonId;
              if (seasonId) {
                console.log(`DEBUG: Attempting to mark season complete:`, {
                  seasonId,
                  isGoalComplete: donation.seasonInfo.isGoalComplete,
                  totalDonated: donation.seasonInfo.totalDonated,
                  goalAmount: donation.seasonInfo.goalAmount
                });
                await seasonGoalService.markSeasonCompleted(seasonId);
                console.log(`DEBUG: Successfully marked season ${seasonId} as complete`);
              } else {
                console.error('Cannot mark season as complete - missing seasonId in donation.seasonInfo:', donation.seasonInfo);
              }
            }
            
            // Mark transaction as processed
            await TransactionRecord.findOneAndUpdate(
              { txHash: donation.txHash },
              {
                status: 'success',
                'donation.donationTxHash': donationResult.txHash,
                'donation.amount': donationData.usdcAmounts[0]
              }
            );
            console.log(`Marked transaction ${donation.txHash} as processed`);
          } else {
            console.error(`Failed to process donation: ${donationResult.message}`);
          }
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

  // Process an ERC20 token transfer
  async processERC20Transfer(tokenAddress, from, to, value, txHash, blockTimestamp) {
    try {
      // Check if we've already successfully processed this transaction
      // by looking it up in our in-memory tracking set
      if (this.processedTransactions.has(txHash)) {
        console.log(`DUPLICATE: Transaction ${txHash} already processed, SKIPPING ENTIRELY`);
        return;
      }
      
      // Skip zero-value transfers
      if (value === 0n || value === BigInt(0)) {
        console.log(`Skipping zero-value ERC20 transfer: ${from} -> ${to}, Token: ${tokenAddress}`);
        // It's safe to mark zero-value transfers as processed immediately
        this.processedTransactions.add(txHash);
        return;
      }
      
      // Convert addresses to lowercase for consistency
      tokenAddress = tokenAddress.toLowerCase();
      from = from.toLowerCase();
      to = to.toLowerCase();
      
      // Debug logging
      console.log(`Checking if wallet ${to} is in watched wallets list...`);
      
      // Check if this is a transfer to a watched wallet
      if (!this.watchedWallets.has(to)) {
        return;
      }
      
      // Get wallet configuration for the recipient
      const walletData = this.watchedWallets.get(to);
      if (!walletData || !walletData.configurations || walletData.configurations.length === 0) {
        console.log(`Wallet ${to} has no valid configurations, skipping`);
        return;
      }
      
      console.log(`ERC20 transfer detected to watched wallet ${to}`);
      console.log(`Token: ${tokenAddress}, From: ${from}, Amount: ${value.toString()}`);
      
      // IMPORTANT: Do NOT mark as processed here - we'll do it after successful donation processing
      
      // Check if the token is USDC (more robust comparison)
      const usdcAddress = (process.env.USDC_CONTRACT_ADDRESS || '').toLowerCase();
      const isUsdc = tokenAddress === usdcAddress;
      
      if (isUsdc) {
        // Process each configuration for this wallet (matching original functionality)
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
          
          // It's USDC, just use the value directly (USDC has 6 decimals)
          const usdcAmount = BigInt(value);
          const usdcFormatted = ethers.formatUnits(usdcAmount, 6);
          console.log(`Received ${usdcFormatted} USDC`);
          
          // Calculate donation amount based on percentage
          const donationAmountFloat = Number(usdcFormatted) * (donationPercentage / 100);
          const donationAmount = (usdcAmount * BigInt(donationPercentage)) / BigInt(100);
          
          console.log(`Calculated donation amount: ${ethers.formatUnits(donationAmount, 6)} USDC (${donationPercentage}%)`);
          console.log(`Float calculation: ${donationAmountFloat.toFixed(6)} USDC`);
          
          // Use same small donation logic as the original implementation
          const SMALLEST_USDC_UNIT = 1n; // 1 unit = 0.000001 USDC
          
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
              console.log(`Checking season goal for ${to} before processing donation...`);
              const seasonCheck = await seasonGoalService.checkAndAdjustDonation(to, finalDonationAmount);
              
              // If season goal check indicates an adjustment is needed
              if (seasonCheck && seasonCheck.needsAdjustment) {
                // Convert adjusted amount to BigInt
                const adjustedAmount = BigInt(seasonCheck.adjustedAmount);
                
                // If the adjusted amount is zero, season goal is already met
                if (adjustedAmount === 0n) {
                  console.log(`⚠️ Season goal already met for wallet ${to}. Skipping donation.`);
                  continue; // Skip this donation entirely
                }
                
                // Update the donation amount to the adjusted amount
                finalDonationAmount = adjustedAmount;
                console.log(`📊 Adjusted donation amount to ${ethers.formatUnits(adjustedAmount, 6)} USDC to meet season goal exactly`);
                
                // Log completion of goal if applicable
                if (seasonCheck.isGoalComplete) {
                  console.log(`🎉 This donation completes the season goal for wallet ${to}!`);
                }
              }
              
              // Now queue the donation for processing with possibly adjusted amount
              // Create donation object matching the original implementation
              const seasonId = seasonCheck.seasonId ? seasonCheck.seasonId.toString() : null;
              console.log(`DEBUG: Season check result:`, {
                seasonId,
                isGoalComplete: seasonCheck.isGoalComplete,
                totalDonated: seasonCheck.totalDonated,
                goalAmount: seasonCheck.goalAmount
              });
              
              this.queueDonation({
                from: to,                                // Watched wallet (sending the donation)
                originalFrom: from,                     // Original transaction sender
                originalTo: to,                         // Original transaction recipient (watched wallet)
                txHash: txHash,
                assetType: 'USDC',
                originalValue: value.toString(),
                usdcEquivalent: value.toString(),       // Store original USDC equivalent
                usdcFormatted: usdcFormatted,          // Store formatted USDC value
                to: config.target,                     // The donation recipient address from the config
                authorized: config.authorized,          // The contract authorized to spend tokens
                configId: config.id,                    // Config ID to update records later
                donationAmount: finalDonationAmount.toString(),
                percentAmount: donationPercentage,
                seasonInfo: seasonId ? {
                  seasonId,
                  isGoalComplete: seasonCheck.isGoalComplete,
                  totalDonated: seasonCheck.totalDonated,
                  goalAmount: seasonCheck.goalAmount
                } : undefined,
                timestamp: blockTimestamp || Math.floor(Date.now() / 1000)  // Use block timestamp
              });
              
              console.log(`Queued donation of ${ethers.formatUnits(finalDonationAmount, 6)} USDC (${donationPercentage}%) to ${config.target}`);
            } catch (error) {
              console.error(`Error checking season goal for wallet ${to}:`, error);
              
              // Fall back to original donation amount if season check fails
              this.queueDonation({
                from: to,                                // Watched wallet (sending the donation)
                originalFrom: from,                     // Original transaction sender
                originalTo: to,                         // Original transaction recipient (watched wallet)
                txHash: txHash,
                assetType: 'USDC',
                originalValue: value.toString(),
                usdcEquivalent: value.toString(),       // Store original USDC equivalent
                usdcFormatted: usdcFormatted,          // Store formatted USDC value
                to: config.target,                     // The donation recipient address from the config
                authorized: config.authorized,          // The contract authorized to spend tokens
                configId: config.id,                    // Config ID to update records later
                donationAmount: finalDonationAmount.toString(),
                percentAmount: donationPercentage,
                timestamp: blockTimestamp || Math.floor(Date.now() / 1000)  // Use block timestamp
              });
            }
          }
        }
      } else {
        console.log(`Unsupported token: ${tokenAddress}. Only USDC is currently supported.`);
      }
      
      // Mark transaction as processed AFTER successful donation processing
      // This ensures we only mark it as processed if we actually handled it properly
      console.log(`Marking transaction ${txHash} as processed`);
      this.processedTransactions.add(txHash);
      
    } catch (error) {
      console.error(`Error processing ERC20 transfer: ${error.message}`);
      // Do NOT mark as processed if we hit an error - we want to retry the transaction
    }
  }

  // Check a transaction to see if it involves a watched wallet
  async checkTransaction(tx, blockTimestamp) {
    try {
      const from = tx.from?.toLowerCase();
      const to = tx.to?.toLowerCase();
      
      // Skip if neither sender nor receiver is a watched wallet
      if (!from || !to || (!this.watchedWallets.has(to) && !this.watchedWallets.has(from))) {
        return;
      }
      
      // Focus on incoming transactions to watched wallets
      if (this.watchedWallets.has(to)) {
        console.log(`Native ETH transfer to watched wallet ${to}`);
        console.log(`From: ${from}, Amount: ${tx.value.toString()}`);
        
        // Get the watched wallet's configuration
        const walletData = this.watchedWallets.get(to);
        if (!walletData || !walletData.configurations || walletData.configurations.length === 0) {
          console.log(`Wallet ${to} has no valid configurations, skipping`);
          return;
        }
        
        // Get USD value of the ETH
        const ethUsdPrice = await priceFeed.getEtherPrice();
        const ethAmount = parseFloat(ethers.formatEther(tx.value));
        const usdAmount = ethAmount * ethUsdPrice;
        
        console.log(`ETH: ${ethAmount}, USD Value: $${usdAmount.toFixed(2)}`);
        
        // Convert ETH USD value to USDC base units (6 decimals)
        // We need this in the same format as USDC for the blockchain service
        const receivedUsdcAmount = BigInt(Math.floor(usdAmount * 1000000)); // 6 decimals for USDC
        
        // Process each configuration for this wallet
        for (const config of walletData.configurations) {
          // Skip if missing critical configuration
          if (!config.target || !config.percentAmount) {
            console.log(`Skipping configuration with missing target or percentAmount`);
            continue;
          }
          
          const donationPercentage = config.percentAmount;
          
          // Skip invalid configurations
          if (!donationPercentage || donationPercentage <= 0) {
            console.log(`Skipping configuration with invalid percentage: ${donationPercentage}`);
            continue;
          }
          
          // Calculate donation amount based on percentage
          // Important: Calculate the donation as the exact percentage of the received amount
          const donationAmountFloat = usdAmount * (donationPercentage / 100);
          const donationAmount = BigInt(Math.floor(donationAmountFloat * 1000000)); // Convert to USDC units
          
          console.log(`Calculated donation amount: ${ethers.formatUnits(donationAmount, 6)} USDC (${donationPercentage}% of ${usdAmount} USD)`);
          
          // Create donation object for processing
          const donation = {
            txHash: tx.hash,
            from: to,                                 // The watched wallet sending the donation
            originalFrom: from,                       // Original transaction sender
            originalTo: to,                           // Original transaction recipient (watched wallet)
            to: config.target,                        // The TARGET specified in the wallet's configuration
            authorized: config.authorized,            // Contract authorized to spend tokens
            configId: config.id,                      // Configuration ID for tracking
            amount: donationAmountFloat,              // USD amount for backward compatibility
            donationAmount: donationAmount.toString(), // USDC amount in base units
            originalValue: tx.value.toString(),       // Original ETH value
            usdcEquivalent: receivedUsdcAmount.toString(), // USDC equivalent of full amount
            usdcFormatted: ethers.formatUnits(receivedUsdcAmount, 6), // Formatted for logging
            percentAmount: donationPercentage,        // Percentage applied
            assetType: 'ETH',                         // Asset type
            tokenType: 'ETH',                         // For backward compatibility
            timestamp: blockTimestamp || Math.floor(Date.now() / 1000)
          };
          
          // Add to processing queue
          this.transactionQueue.push(donation);
          console.log(`Added ETH donation to queue: From ${to} to ${config.target} for ${ethers.formatUnits(donationAmount, 6)} USDC (${donationPercentage}%)`);
        }
      }
    } catch (error) {
      console.error(`Error checking transaction: ${error.message}`);
    }
  }

  // Get token details and USD value
  async getTokenDetails(tokenAddress, value) {
    // Normalize addresses
    const usdcAddress = (process.env.USDC_CONTRACT_ADDRESS || '').toLowerCase();
    const wethAddress = (process.env.WETH_CONTRACT_ADDRESS || '').toLowerCase();
    
    try {
      // Handle USDC
      if (tokenAddress === usdcAddress) {
        // USDC has 6 decimals
        const usdcAmount = parseFloat(ethers.formatUnits(value, 6));
        return {
          tokenType: 'USDC',
          tokenSymbol: 'USDC',
          usdAmount: usdcAmount // USDC is a stablecoin, 1 USDC = 1 USD
        };
      }
      
      // Handle WETH
      if (tokenAddress === wethAddress) {
        // WETH has 18 decimals
        const wethAmount = parseFloat(ethers.formatEther(value));
        const ethUsdPrice = await priceFeed.getEtherPrice();
        const usdAmount = wethAmount * ethUsdPrice;
        
        return {
          tokenType: 'WETH',
          tokenSymbol: 'WETH',
          usdAmount
        };
      }
      
      // Other tokens not supported yet
      return null;
    } catch (error) {
      console.error(`Error getting token details: ${error.message}`);
      return null;
    }
  }
}

module.exports = new MoralisWatcher();
