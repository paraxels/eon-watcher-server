const { ethers } = require('ethers');
require('dotenv').config();

async function checkTransaction() {
    const txHash = '0xf5fc80091d798aa1bcfcd33de97db934dba4e7037a02e7b5aa3d22265719a3a7';
    console.log('Checking transaction:', txHash);
    
    // Create a provider
    const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
    
    // Get transaction details
    const tx = await provider.getTransaction(txHash);
    console.log('Transaction details:', {
        from: tx.from.toLowerCase(),
        to: tx.to.toLowerCase(),
        value: ethers.formatEther(tx.value),
        blockNumber: tx.blockNumber
    });
    
    // Get receipt to confirm it was successful
    const receipt = await provider.getTransactionReceipt(txHash);
    console.log('Receipt status:', receipt.status);
}

checkTransaction()
    .then(() => console.log('Check complete'))
    .catch(error => console.error('Error:', error));
