require('dotenv').config();
const { ethers } = require('ethers');

async function checkTransaction() {
  // The transaction hash to check
  const txHash = '0xe3f0266bcb2f70ec3d321ca0aa524bc5e7680b241106f52762a72cd2fd4b3e5c';
  
  console.log(`Checking specific transaction: ${txHash}...`);
  
  try {
    // Create provider
    const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
    
    // Get transaction details
    const tx = await provider.getTransaction(txHash);
    if (!tx) {
      console.log(`Transaction not found: ${txHash}`);
      return;
    }
    
    console.log('Transaction found with details:');
    console.log('  Hash:      ', tx.hash);
    console.log('  Block:     ', tx.blockNumber);
    console.log('  From:      ', tx.from);
    console.log('  To:        ', tx.to);
    console.log('  Value:     ', tx.value ? ethers.formatEther(tx.value) + ' ETH' : '0 ETH');
    console.log('  Data:      ', tx.data && tx.data.length > 66 ? tx.data.substring(0, 66) + '...' : tx.data);
    
    // Check if it's a token transfer
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt && receipt.logs) {
      console.log('Transaction includes logs:', receipt.logs.length);
      
      // Check for ERC20 transfer events
      const transferEventTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      
      for (const log of receipt.logs) {
        // Check if this is a Transfer event
        if (log.topics[0] === transferEventTopic && log.topics.length === 3) {
          // Extract addresses (remove padding and convert to checksum addresses)
          const from = '0x' + log.topics[1].substring(26);
          const to = '0x' + log.topics[2].substring(26);
          
          // Extract amount from data field
          const value = BigInt(log.data);
          
          console.log('\nFound ERC20 Transfer event:');
          console.log('  Token:     ', log.address);
          console.log('  From:      ', from);
          console.log('  To:        ', to);
          console.log('  Value:     ', value.toString());
          
          // Get token details
          try {
            const tokenContract = new ethers.Contract(
              log.address,
              [
                'function name() view returns (string)',
                'function symbol() view returns (string)',
                'function decimals() view returns (uint8)'
              ],
              provider
            );
            
            const [name, symbol, decimals] = await Promise.all([
              tokenContract.name().catch(() => 'Unknown'),
              tokenContract.symbol().catch(() => 'Unknown'),
              tokenContract.decimals().catch(() => 18)
            ]);
            
            console.log('  Token Name:', name);
            console.log('  Symbol:    ', symbol);
            console.log('  Decimals:  ', decimals);
            console.log('  Formatted: ', ethers.formatUnits(value, decimals), symbol);
          } catch (error) {
            console.error('  Error getting token details:', error.message);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error checking transaction:', error);
  }
}

checkTransaction().then(() => console.log('Done')).catch(console.error);
