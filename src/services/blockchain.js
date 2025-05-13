const { ethers } = require('ethers');
require('dotenv').config();

// More complete ABI for the EON contract
const EON_ABI = [
  // Core donation functions
  "function donate(address[] memory froms, address[] memory tos, uint[] memory donationTimes, uint[] memory usdcAmounts) external",
  "function isExecutor(address executor) external view returns (bool)",
  
  // Donation history and stats
  "function getLastDonationTime(address user) external view returns (uint)",
  "function getTotalDonated(address user) external view returns (uint)",
  "function getTotalEarned(address user) external view returns (uint)",
  
  // Fee management
  "function getDonationFee() external view returns (uint)",
  
  // Events
  "event Donation(address indexed from, address indexed to, uint quantity, uint fee, uint donationTime)"
];

const USDC_ABI = [
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)"
];

class BlockchainService {
  constructor() {
    // Use Alchemy endpoint for higher rate limits
    const rpcUrl = process.env.ALCHEMY_BASE_RPC_URL || process.env.BASE_RPC_URL;
    console.log(`Using RPC endpoint: ${rpcUrl === process.env.ALCHEMY_BASE_RPC_URL ? 'Alchemy (higher rate limits)' : 'Base RPC'}`);
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);
    
    // Store the default EON contract (from .env) as a fallback
    this.defaultEonContract = new ethers.Contract(
      process.env.EON_CONTRACT_ADDRESS,
      EON_ABI,
      this.wallet
    );
    
    // Map to store EON contracts by address
    this.eonContractsByAddress = new Map();
    this.eonContractsByAddress.set(
      process.env.EON_CONTRACT_ADDRESS.toLowerCase(),
      this.defaultEonContract
    );
    
    this.usdcContract = new ethers.Contract(
      process.env.USDC_CONTRACT_ADDRESS,
      USDC_ABI,
      this.wallet
    );
    
    this.decimals = 6; // Default for USDC, will be confirmed in init()
  }

  async init() {
    try {
      // Check if our wallet is an executor on the default EON contract
      const isExecutor = await this.defaultEonContract.isExecutor(this.wallet.address);
      if (!isExecutor) {
        console.error("Warning: The wallet is not registered as an executor in the default EON contract");
      }
      
      // Get USDC decimals
      this.decimals = await this.usdcContract.decimals();
      console.log(`USDC configured with ${this.decimals} decimals`);
      
      console.log("Blockchain service initialized successfully");
    } catch (error) {
      console.error("Failed to initialize blockchain service:", error);
      throw error;
    }
  }

  async checkAllowance(userAddress, spenderAddress = null) {
    try {
      // Use the provided spender address or default to the one from .env
      const spender = spenderAddress || process.env.EON_CONTRACT_ADDRESS;
      
      const allowance = await this.usdcContract.allowance(
        userAddress,
        spender
      );
      return allowance;
    } catch (error) {
      console.error(`Error checking allowance for ${userAddress}:`, error);
      throw error;
    }
  }

  async checkBalance(userAddress) {
    try {
      const balance = await this.usdcContract.balanceOf(userAddress);
      return balance;
    } catch (error) {
      console.error(`Error checking balance for ${userAddress}:`, error);
      throw error;
    }
  }

  // Get or create an EON contract instance for a specific address
  getEonContract(contractAddress) {
    // Use the default contract if no address is provided
    if (!contractAddress) {
      return this.defaultEonContract;
    }
    
    const address = contractAddress.toLowerCase();
    
    // Return cached contract if we already have it
    if (this.eonContractsByAddress.has(address)) {
      return this.eonContractsByAddress.get(address);
    }
    
    // Create a new contract instance
    const contract = new ethers.Contract(
      contractAddress,
      EON_ABI,
      this.wallet
    );
    
    // Cache it for future use
    this.eonContractsByAddress.set(address, contract);
    
    return contract;
  }
  
  // Helper function to delay execution for a specified time
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async processDonations(donationData) {
    // Retry configuration
    const maxRetries = 5;
    let currentRetry = 0;
    
    // Function to determine if an error is a rate limit error
    const isRateLimitError = (error) => {
      return error && (
        (error.message && (error.message.includes('rate limit') || error.message.includes('over rate limit'))) ||
        (error.error && error.error.message && (error.error.message.includes('rate limit') || error.error.message.includes('over rate limit'))) ||
        (error.code === -32016) ||
        (error.error && error.error.code === -32016)
      );
    };
    
    while (currentRetry <= maxRetries) {
      try {
        // Extract contract address if provided
        const contractAddress = donationData.contractAddress;
        
        // Get the appropriate EON contract instance
        const eonContract = this.getEonContract(contractAddress);
        
        // Check if we have donation data in different formats
        let froms, tos, donationTimes, usdcAmounts;
        
        if (Array.isArray(donationData)) {
          // Processing a flat array of donation objects
          if (donationData.length === 0) {
            console.log("No donations to process");
            return { success: true, message: "No donations to process" };
          }
          
          froms = [];
          tos = [];
          donationTimes = [];
          usdcAmounts = [];
          
          const currentTimestamp = Math.floor(Date.now() / 1000);
          
          // Prepare donation arrays
          for (const donation of donationData) {
            froms.push(donation.from);
            tos.push(donation.to);
            donationTimes.push(currentTimestamp);
            usdcAmounts.push(donation.amount);
          }
        } else {
          // Processing pre-formatted arrays
          froms = donationData.froms || [];
          tos = donationData.tos || [];
          donationTimes = donationData.donationTimes || [];
          usdcAmounts = donationData.usdcAmounts || [];
          
          if (froms.length === 0 || froms.length !== tos.length || 
              froms.length !== donationTimes.length || froms.length !== usdcAmounts.length) {
            console.log("Invalid donation data format");
            return { success: false, message: "Invalid donation data format" };
          }
        }

        // Check if there's anything to process
        if (froms.length === 0) {
          console.log("No donations to process");
          return { success: true, message: "No donations to process" };
        }

        // Submit donation transaction
        console.log(`Submitting ${froms.length} donations to EON contract at ${eonContract.target}...`);
        
        // Check if our wallet is an executor for this contract - with retry for rate limiting
        let isExecutor = false;
        let executorRetries = 0;
        const maxExecutorRetries = 3;
        
        while (executorRetries < maxExecutorRetries) {
          try {
            isExecutor = await eonContract.isExecutor(this.wallet.address);
            break; // Success, exit the retry loop
          } catch (execError) {
            if (isRateLimitError(execError) && executorRetries < maxExecutorRetries - 1) {
              const backoffTime = Math.pow(2, executorRetries) * 1000; // Exponential backoff
              console.log(`Rate limited when checking executor status. Retrying in ${backoffTime}ms...`);
              await this.delay(backoffTime);
              executorRetries++;
            } else {
              throw execError; // Not a rate limit error or max retries reached
            }
          }
        }
        
        if (!isExecutor) {
          console.error(`This wallet is not registered as an executor for the EON contract at ${eonContract.target}`);
          return { success: false, message: "Wallet is not an executor for this contract" };
        }
        
        // Check allowances before donating - with rate limit handling
        for (let i = 0; i < froms.length; i++) {
          let allowance;
          let allowanceRetries = 0;
          const maxAllowanceRetries = 3;
          
          while (allowanceRetries < maxAllowanceRetries) {
            try {
              allowance = await this.checkAllowance(froms[i], eonContract.target);
              break; // Success, exit the retry loop
            } catch (allowanceError) {
              if (isRateLimitError(allowanceError) && allowanceRetries < maxAllowanceRetries - 1) {
                const backoffTime = Math.pow(2, allowanceRetries) * 1000; // Exponential backoff
                console.log(`Rate limited when checking allowance. Retrying in ${backoffTime}ms...`);
                await this.delay(backoffTime);
                allowanceRetries++;
              } else {
                throw allowanceError; // Not a rate limit error or max retries reached
              }
            }
          }
          
          if (BigInt(allowance) < BigInt(usdcAmounts[i])) {
            console.log(`Insufficient allowance for ${froms[i]}: has ${allowance}, needs ${usdcAmounts[i]}`);
            // Filter out this donation
            froms.splice(i, 1);
            tos.splice(i, 1);
            donationTimes.splice(i, 1);
            usdcAmounts.splice(i, 1);
            i--; // Adjust index since we removed an element
          }
        }
        
        if (froms.length === 0) {
          console.log("No donations left after allowance check");
          return { success: false, message: "No donations with sufficient allowance" };
        }
        
        // Send the donation with retry for rate limiting
        let tx;
        try {
          tx = await eonContract.donate(froms, tos, donationTimes, usdcAmounts);
        } catch (txError) {
          if (isRateLimitError(txError) && currentRetry < maxRetries) {
            const backoffTime = Math.pow(2, currentRetry) * 1000; // Exponential backoff starting at 1s
            console.log(`Rate limited when sending transaction. Retrying in ${backoffTime}ms... (Attempt ${currentRetry + 1}/${maxRetries})`);
            await this.delay(backoffTime);
            currentRetry++;
            continue; // Retry the whole operation
          } else {
            throw txError; // Not a rate limit error or max retries reached
          }
        }
        
        // Wait for transaction to be processed, with retry for rate limiting
        let receipt;
        let receiptRetries = 0;
        const maxReceiptRetries = 5;
        
        while (receiptRetries < maxReceiptRetries) {
          try {
            receipt = await tx.wait();
            break; // Success, exit the retry loop
          } catch (receiptError) {
            if (isRateLimitError(receiptError) && receiptRetries < maxReceiptRetries - 1) {
              const backoffTime = Math.pow(2, receiptRetries) * 1000; // Exponential backoff
              console.log(`Rate limited when waiting for receipt. Retrying in ${backoffTime}ms...`);
              await this.delay(backoffTime);
              receiptRetries++;
            } else {
              throw receiptError; // Not a rate limit error or max retries reached
            }
          }
        }
        
        console.log(`Donations processed successfully. Transaction hash: ${receipt.hash}`);
        return {
          success: true,
          message: `Donations processed successfully`,
          transactionHash: receipt.hash
        };
        
      } catch (error) {
        // Check if it's a rate limit error and we haven't exceeded max retries
        if (isRateLimitError(error) && currentRetry < maxRetries) {
          const backoffTime = Math.pow(2, currentRetry) * 1000; // Exponential backoff starting at 1s
          console.log(`Rate limited. Retrying in ${backoffTime}ms... (Attempt ${currentRetry + 1}/${maxRetries})`);
          await this.delay(backoffTime);
          currentRetry++;
        } else {
          // If it's not a rate limit error or we've exceeded max retries, return the error
          console.error("Error processing donations after retries:", error);
          return {
            success: false,
            message: `Error processing donations: ${error.message}`,
            error
          };
        }
      }
    }
    
    // If we've exhausted all retries
    return {
      success: false,
      message: "Failed to process donations after maximum retries due to rate limiting"
    };
  }
}

module.exports = new BlockchainService();
