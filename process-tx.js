const { ethers } = require('ethers');
const ExistingWallet = require('./src/models/ExistingWallet');
const blockchainService = require('./src/services/blockchain');
const priceFeed = require('./src/services/priceFeed');
const mongoose = require('mongoose');
require('dotenv').config();

// Define the EON ABI - needed for direct interaction
const EON_ABI = [
  "function donate(address[] memory froms, address[] memory tos, uint[] memory donationTimes, uint[] memory usdcAmounts) external",
  "function isExecutor(address executor) external view returns (bool)",
  "function getLastDonationTime(address user) external view returns (uint)",
  "function getDonationFee() external view returns (uint)"
];

async function processSpecificTransaction() {
  const txHash = '0xf5fc80091d798aa1bcfcd33de97db934dba4e7037a02e7b5aa3d22265719a3a7';
  console.log('===============================');
  console.log('Processing specific transaction:', txHash);
  console.log('===============================');
  
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');
    
    // Initialize price feed
    await priceFeed.init();
    console.log('Price feed initialized');
    
    // Initialize blockchain service
    await blockchainService.init();
    console.log('Blockchain service initialized');
    
    // Create a provider
    const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
    
    // Get the transaction details
    const tx = await provider.getTransaction(txHash);
    if (!tx) {
      console.error('Transaction not found');
      process.exit(1);
    }
    
    // Check if receipt exists and transaction was successful
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) {
      console.error('Transaction failed or receipt not available');
      process.exit(1);
    }
    
    console.log('Transaction details:');
    console.log({
      from: tx.from.toLowerCase(),
      to: tx.to.toLowerCase(),
      value: ethers.formatEther(tx.value),
      blockNumber: tx.blockNumber
    });
    
    // Find the wallet configuration in MongoDB
    const walletConfig = await ExistingWallet.findOne({
      walletAddress: tx.to.toLowerCase(),
      active: true
    }).sort({ timestamp: -1 });
    
    if (!walletConfig) {
      console.error('No wallet configuration found for recipient:', tx.to.toLowerCase());
      process.exit(1);
    }
    
    console.log('Found wallet configuration:');
    console.log({
      walletAddress: walletConfig.walletAddress,
      target: walletConfig.target,
      percentAmount: walletConfig.percentAmount,
      authorized: walletConfig.authorized
    });
    
    // Convert ETH to USDC value
    const usdcEquivalent = priceFeed.convertEthToUsdc(tx.value);
    const donationPercentage = walletConfig.percentAmount;
    
    // Calculate donation amount
    const donationAmount = (usdcEquivalent * BigInt(donationPercentage)) / BigInt(100);
    
    console.log(`Transaction value: ${ethers.formatEther(tx.value)} ETH = ${usdcEquivalent / BigInt(1e6)} USDC`);
    console.log(`Calculated donation amount: ${donationAmount / BigInt(1e6)} USDC (${donationPercentage}%)`);
    
    // Create the donation data
    const donationData = {
      froms: [tx.to.toLowerCase()],
      tos: [walletConfig.target],
      donationTimes: [Math.floor(Date.now() / 1000)],
      usdcAmounts: [donationAmount.toString()],
      contractAddress: walletConfig.authorized
    };
    
    // Check if the wallet is an executor
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const eonContract = new ethers.Contract(walletConfig.authorized, EON_ABI, wallet);
    const isExecutor = await eonContract.isExecutor(wallet.address);
    console.log(`Is wallet ${wallet.address} an executor? ${isExecutor}`);
    
    if (!isExecutor) {
      console.error('Wallet is not an executor for this contract, cannot donate');
      process.exit(1);
    }
    
    // Process the donation
    console.log('Submitting donation to EON contract...');
    const result = await blockchainService.processDonations(donationData);
    
    if (result.success) {
      console.log('Donation processed successfully!');
      console.log('Transaction hash:', result.transactionHash);
    } else {
      console.error('Failed to process donation:', result.message);
    }
    
  } catch (error) {
    console.error('Error processing transaction:', error);
  } finally {
    // Close the MongoDB connection
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
    process.exit(0);
  }
}

processSpecificTransaction();
