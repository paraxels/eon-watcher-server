const mongoose = require('mongoose');

// Schema for tracking successful donation transactions
const transactionRecordSchema = new mongoose.Schema({
  // Transaction information
  txHash: {
    type: String,
    required: true,
    unique: true
  },
  // Original transaction details
  originalTransaction: {
    from: String,         // Original sender
    to: String,           // Original recipient (watched wallet)
    value: String,        // Original value in wei/smallest unit
    assetType: String,    // ETH, USDC, WETH, etc.
    usdcValue: String     // Value converted to USDC (in smallest unit)
  },
  // Donation details
  donation: {
    from: String,               // Donation sender (watched wallet)
    to: String,                 // Donation recipient
    amount: String,             // Donation amount in USDC (smallest unit, same as amount)
    usdcValue: String,          // USDC value in base units (smallest unit)
    percentAmount: Number,      // Percentage of original transaction
    contractAddress: String,    // EON contract used
    donationTxHash: String      // Blockchain transaction hash of the donation
  },
  // Timestamps
  blockTimestamp: {
    type: Number,               // Timestamp of original block
    required: true
  },
  processedAt: {
    type: Number,               // When the donation was processed
    required: true
  },
  // Config information for reference
  configId: {
    type: mongoose.Schema.Types.ObjectId, // Reference to the configuration that triggered this
    ref: 'ExistingWallet'
  },
  // Status information
  status: {
    type: String,
    enum: ['success', 'failed', 'pending'],
    default: 'pending'
  },
  error: String  // If status is 'failed', record the error message
}, {
  collection: 'transaction_records',
  timestamps: true // Add createdAt and updatedAt timestamps
});

// Indexes for efficient querying
transactionRecordSchema.index({ txHash: 1 });
transactionRecordSchema.index({ 'donation.from': 1 });
transactionRecordSchema.index({ 'donation.to': 1 });
transactionRecordSchema.index({ blockTimestamp: 1 });
transactionRecordSchema.index({ processedAt: 1 });
transactionRecordSchema.index({ status: 1 });

module.exports = mongoose.model('TransactionRecord', transactionRecordSchema);
