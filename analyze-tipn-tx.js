const { ethers } = require('ethers');
require('dotenv').config();

async function analyzeTipnTransaction(txHash) {
  console.log(`Analyzing Tipn transaction: ${txHash}`);
  
  // Configure provider
  const alchemyApiKey = process.env.ALCHEMY_API_KEY || '';
  const rpcUrl = process.env.ALCHEMY_BASE_RPC_URL || `https://base-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;
  
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  
  const receipt = await provider.getTransactionReceipt(txHash);
  
  if (!receipt) {
    console.log('Receipt not found');
    return;
  }
  
  console.log(`Transaction had ${receipt.logs.length} logs`);
  
  // Check if our watched address appears in any of the logs
  const watchedAddress = '0x1caa86bbf01542a48fb2a8df638da0c046605c59'.toLowerCase();
  const usdcAddress = process.env.USDC_CONTRACT_ADDRESS?.toLowerCase();
  
  console.log(`Watching for address: ${watchedAddress}`);
  console.log(`USDC contract address: ${usdcAddress}`);
  
  for (let i = 0; i < receipt.logs.length; i++) {
    const log = receipt.logs[i];
    console.log(`\nLog #${i+1}:`);
    console.log(`Address: ${log.address}`);
    console.log(`Topics: ${JSON.stringify(log.topics)}`);
    console.log(`Data: ${log.data}`);
    
    // Try to decode if it's a Transfer event
    if (log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
      console.log('This appears to be a Transfer event');
      
      if (log.topics.length >= 3) {
        const from = '0x' + log.topics[1].substring(26).toLowerCase();
        const to = '0x' + log.topics[2].substring(26).toLowerCase();
        console.log(`From: ${from}`);
        console.log(`To: ${to}`);
        
        // Parse the data field as a BigInt
        try {
          const value = BigInt(log.data);
          console.log(`Value: ${value.toString()}`);
          
          // Check if this is a USDC contract
          if (log.address.toLowerCase() === usdcAddress) {
            console.log('*** THIS IS A USDC TRANSFER ***');
          }
          
          // Check if this involves our watched address
          if (to === watchedAddress) {
            console.log('*** THIS LOG INVOLVES OUR WATCHED ADDRESS AS RECIPIENT ***');
          }
          
          if (from === watchedAddress) {
            console.log('*** THIS LOG INVOLVES OUR WATCHED ADDRESS AS SENDER ***');
          }
        } catch (error) {
          console.log(`Error parsing value: ${error.message}`);
        }
      } else {
        console.log('Transfer event has unexpected format (topics.length < 3)');
      }
    }
  }
  
  // Also get the transaction details to see who initiated it
  const tx = await provider.getTransaction(txHash);
  if (tx) {
    console.log('\nTransaction details:');
    console.log(`From: ${tx.from}`);
    console.log(`To: ${tx.to}`);
    console.log(`Value: ${tx.value.toString()}`);
  }
}

// Run the analysis on the specific transaction
analyzeTipnTransaction('0xbaf287172465d3d206ce0ceeb7c9a86d975d6df59aa6f9780cf19421400d796d')
  .then(() => console.log('Analysis complete'))
  .catch(error => console.error('Error during analysis:', error));
