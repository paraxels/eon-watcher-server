require('dotenv').config();
const watcher = require('./src/services/watcher');
const { ethers } = require('ethers');

async function checkSpecificTransaction(txHash) {
  console.log(`\n======= CHECKING TRANSACTION: ${txHash} =======\n`);
  
  try {
    // Get transaction details
    const tx = await watcher.provider.getTransaction(txHash);
    if (!tx) {
      console.log(`❌ TRANSACTION NOT FOUND: ${txHash}`);
      return;
    }
    
    console.log(`✅ TRANSACTION FOUND:`);
    console.log(`   Block Number: ${tx.blockNumber}`);
    console.log(`   From:         ${tx.from}`);
    console.log(`   To:           ${tx.to}`);
    console.log(`   Value:        ${ethers.formatEther(tx.value)} ETH`);
    
    // Check if recipient is in watched wallets
    const recipient = tx.to.toLowerCase();
    const isWatchedWallet = watcher.watchedWallets.has(recipient);
    
    console.log(`\n🔍 WATCHED WALLET CHECK:`);
    console.log(`   Recipient: ${recipient}`);
    console.log(`   Is watched? ${isWatchedWallet ? 'YES' : 'NO'}`);
    
    if (isWatchedWallet) {
      console.log(`\n💼 WALLET CONFIG:`, watcher.watchedWallets.get(recipient));
    }
    
    console.log(`\n⚙️ PROCESSING TRANSACTION...`);
    
    // Manually process this transaction through our system
    await watcher.checkTransaction(tx);
    
    console.log(`\n✅ TRANSACTION PROCESSING COMPLETE`);
  } catch (error) {
    console.error(`\n❌ ERROR:`, error);
  }
}

// Get transaction hash from command line
const txHash = process.argv[2];
if (!txHash) {
  console.log('Please provide a transaction hash as an argument');
  process.exit(1);
}

// Check the transaction
checkSpecificTransaction(txHash).then(() => {
  console.log('\nDONE');
}).catch(err => {
  console.error('Fatal error:', err);
}).finally(() => {
  // Don't exit immediately to allow async operations to complete
  setTimeout(() => process.exit(0), 2000);
});
