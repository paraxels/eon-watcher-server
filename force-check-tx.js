// Script to force check a specific transaction
require('dotenv').config();
const { ethers } = require('ethers');
const watcher = require('./src/services/watcher');

async function forceCheckTransaction() {
  // The transaction we want to check
  const txHash = '0xe3f0266bcb2f70ec3d321ca0aa524bc5e7680b241106f52762a72cd2fd4b3e5c';
  
  console.log('FORCE CHECKING TRANSACTION:', txHash);
  
  try {
    // Get the provider
    const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
    
    // Get transaction details
    const tx = await provider.getTransaction(txHash);
    
    if (!tx) {
      console.log('TRANSACTION NOT FOUND');
      return;
    }
    
    console.log('TRANSACTION FOUND:');
    console.log('  Block Number:', tx.blockNumber);
    console.log('  From:        ', tx.from);
    console.log('  To:          ', tx.to);
    console.log('  Value:       ', ethers.formatEther(tx.value), 'ETH');
    
    // Check if the recipient is one of our watched wallets
    const wallets = Array.from(watcher.watchedWallets.keys());
    console.log('WATCHED WALLETS:', wallets);
    
    const recipient = tx.to.toLowerCase();
    const isWatched = wallets.includes(recipient);
    
    console.log(`IS RECIPIENT WATCHED? ${isWatched ? 'YES' : 'NO'}`);
    
    // Force process the transaction
    console.log('FORCING TRANSACTION PROCESSING...');
    await watcher.checkTransaction(tx);
    
    console.log('TRANSACTION PROCESSING COMPLETE');
  } catch (error) {
    console.error('ERROR:', error);
  }
}

forceCheckTransaction()
  .then(() => console.log('DONE'))
  .catch(console.error);
