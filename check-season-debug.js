#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const ExistingWallet = require('./src/models/ExistingWallet');
const TransactionRecord = require('./src/models/TransactionRecord');
const seasonGoalService = require('./src/services/seasonGoals');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

async function debugSeasonGoal() {
  try {
    // Get an example wallet address
    const walletAddress = '0xcb8043841904f69952c334bba47fd769445eb074';
    
    // 1. Get season record
    const season = await ExistingWallet.findOne({
      walletAddress: new RegExp(`^${walletAddress}$`, 'i'),
      dollarAmount: { $exists: true, $ne: null }
    }).sort({ timestamp: -1 }).limit(1);
    
    if (!season) {
      console.log(`No season record found for ${walletAddress}`);
      return;
    }
    
    console.log(`Found season record:`, {
      id: season._id,
      walletAddress: season.walletAddress,
      dollarAmount: season.dollarAmount,
      active: season.active,
      timestamp: season.timestamp,
      created: season._id.getTimestamp()
    });
    
    // 2. Determine season timeframe
    // Use the season record's creation time as the start timestamp
    const seasonCreateTime = season._id.getTimestamp();
    const startTimestamp = Math.floor(seasonCreateTime.getTime() / 1000);
    const currentTimestamp = Math.floor(Date.now() / 1000);
    
    console.log(`Season period: From ${new Date(startTimestamp * 1000).toISOString()} to ${new Date(currentTimestamp * 1000).toISOString()}`);
    
    // 3. Count all transactions for this wallet (no time filter)
    const allTx = await TransactionRecord.find({
      'donation.from': new RegExp(`^${walletAddress}$`, 'i'),
      status: 'success'
    });
    
    console.log(`Total transactions (no time filter): ${allTx.length}`);
    
    // 4. Check if blockTimestamp is properly saved in documents
    if (allTx.length > 0) {
      const sampleTx = allTx[0];
      console.log(`Sample transaction:`, {
        txHash: sampleTx.txHash,
        blockTimestamp: sampleTx.blockTimestamp,
        blockTimestampType: typeof sampleTx.blockTimestamp,
        date: sampleTx.blockTimestamp ? new Date(sampleTx.blockTimestamp * 1000).toISOString() : 'No timestamp'
      });
    }
    
    // 5. Get transactions with explicit time filter
    const filteredTx = await TransactionRecord.find({
      'donation.from': new RegExp(`^${walletAddress}$`, 'i'),
      status: 'success',
      blockTimestamp: {
        $gte: startTimestamp,
        $lte: currentTimestamp
      }
    });
    
    console.log(`Filtered transactions (with time filter): ${filteredTx.length}`);
    
    // 6. Log the first few filtered transactions
    console.log('Filtered transactions:');
    filteredTx.slice(0, 5).forEach((tx, i) => {
      console.log(`  ${i+1}. TxHash: ${tx.txHash}, Timestamp: ${tx.blockTimestamp}, Date: ${new Date(tx.blockTimestamp * 1000).toISOString()}`);
    });
    
    // Check for transactions exactly at startTimestamp
    const edgeCaseTx = await TransactionRecord.find({
      'donation.from': new RegExp(`^${walletAddress}$`, 'i'),
      status: 'success',
      blockTimestamp: startTimestamp
    });
    
    console.log(`Transactions exactly at startTimestamp (${startTimestamp}): ${edgeCaseTx.length}`);
    
    // Finally, manually calculate filtered transactions
    let manuallyFiltered = 0;
    for (const tx of allTx) {
      if (tx.blockTimestamp >= startTimestamp && tx.blockTimestamp <= currentTimestamp) {
        manuallyFiltered++;
      }
    }
    
    console.log(`Manually filtered transactions: ${manuallyFiltered}`);
    
    // Disconnect from MongoDB
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  } catch (error) {
    console.error('Error debugging season goal:', error);
    await mongoose.disconnect();
  }
}

// Run the debug function
debugSeasonGoal();
