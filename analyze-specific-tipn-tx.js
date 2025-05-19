const { ethers } = require('ethers');
require('dotenv').config();

async function analyzeSpecificTransaction() {
  const txHash = '0xbb53606eb16a3e4312f8e2e16169b2f318eb06f22596b36f39c7f86186bdfc1c';
  const watchedWallet = '0x1caA86bBF01542a48Fb2A8df638dA0C046605C59'.toLowerCase();
  
  console.log(`Analyzing transaction: ${txHash}`);
  console.log(`Watched wallet: ${watchedWallet}`);
  
  // Configure provider
  const alchemyApiKey = process.env.ALCHEMY_API_KEY || '';
  const rpcUrl = process.env.ALCHEMY_BASE_RPC_URL || `https://base-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;
  
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  
  try {
    // Get transaction details
    const tx = await provider.getTransaction(txHash);
    if (!tx) {
      console.log('Transaction not found');
      return;
    }
    
    console.log('\nTransaction details:');
    console.log(`From: ${tx.from || 'unknown'}`);
    console.log(`To: ${tx.to || 'unknown'}`);
    console.log(`Value: ${tx.value?.toString() || '0'}`);
    console.log(`Chain ID: ${tx.chainId || 'unknown'}`);
    console.log(`Nonce: ${tx.nonce || 'unknown'}`);
    
    // Safely check for input data
    if (tx.data || tx.input) {
      const inputData = tx.data || tx.input;
      console.log(`Input data: ${inputData.substring(0, 10)}...${inputData.length > 10 ? ` (${inputData.length} bytes)` : ''}`); 
    } else {
      console.log('No input data available');
    }
    
    // Get receipt
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      console.log('Transaction receipt not found');
      return;
    }
    
    console.log(`\nReceipt status: ${receipt.status ? 'Success' : 'Failed'}`);
    console.log(`Block number: ${receipt.blockNumber}`);
    console.log(`Gas used: ${receipt.gasUsed}`);
    console.log(`Logs count: ${receipt.logs.length}`);
    
    // Check logs for USDC transfers
    const transferEventTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const usdcAddress = process.env.USDC_CONTRACT_ADDRESS.toLowerCase();
    
    console.log('\nAnalyzing logs for USDC transfers to watched wallet:');
    
    let foundTransfer = false;
    
    for (let i = 0; i < receipt.logs.length; i++) {
      const log = receipt.logs[i];
      
      // Check if this is a USDC Transfer event
      if (log.address.toLowerCase() === usdcAddress && 
          log.topics[0] === transferEventTopic && 
          log.topics.length >= 3) {
        
        const from = '0x' + log.topics[1].substring(26).toLowerCase();
        const to = '0x' + log.topics[2].substring(26).toLowerCase();
        const value = BigInt(log.data);
        
        console.log(`\nLog #${i + 1}:`);
        console.log(`USDC Transfer from ${from} to ${to}`);
        console.log(`Value: ${value.toString()}`);
        
        if (to === watchedWallet) {
          foundTransfer = true;
          console.log(`*** THIS IS THE TRANSFER TO OUR WATCHED WALLET ***`);
        }
      }
    }
    
    if (!foundTransfer) {
      console.log('No USDC transfers to the watched wallet found in this transaction');
    }
    
    // Get the block to check timing
    const block = await provider.getBlock(receipt.blockNumber);
    console.log(`\nBlock timestamp: ${new Date(block.timestamp * 1000).toISOString()}`);
    
    // Decode the input data if it's to the Tipn contract
    const tipnContractAddress = '0x3dA41Dc20a8b6e52F12eF5706Da9613d5867eF86'.toLowerCase();
    if (tx.to?.toLowerCase() === tipnContractAddress) {
      console.log('\nTransaction is to the Tipn contract - analyzing input data:');
      
      // The tip function signature
      const tipFunctionSignature = '0x1c92881f'; // tip(address[],address[],uint256[],uint256[])
      const inputData = tx.data || tx.input;
      
      if (inputData && inputData.startsWith(tipFunctionSignature)) {
        console.log('Input data matches the tip function signature');
        
        // Unfortunately, detailed decoding would require the full ABI, so we'll just note this
        console.log('This is a call to the tip() function of the Tipn contract');
      } else if (inputData) {
        console.log(`Input data doesn't match the tip function signature`);
        console.log(`Function signature in input: ${inputData.substring(0, 10)}`);
      } else {
        console.log('No input data available to check function signature');
      }
    }
  } catch (error) {
    console.error('Error analyzing transaction:', error);
  }
}

analyzeSpecificTransaction()
  .then(() => console.log('\nAnalysis complete'))
  .catch(error => console.error('Error during analysis:', error));
