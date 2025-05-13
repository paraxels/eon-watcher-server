const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
  address: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
  },
  allowance: {
    type: String, // Using String for BigInt compatibility
    default: '0'
  },
  lastDonationTimestamp: {
    type: Number,
    default: 0
  },
  donationRecipients: [{
    address: {
      type: String,
      required: true,
      lowercase: true
    },
    percentage: {
      type: Number,
      required: true,
      min: 1,
      max: 100
    }
  }],
  donationInterval: {
    type: String,
    enum: ['daily', 'weekly', 'monthly'],
    default: 'monthly'
  },
  donationAmount: {
    type: String, // Using String for BigInt compatibility
    default: '0'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Index for faster queries
walletSchema.index({ address: 1 });
walletSchema.index({ isActive: 1 });
walletSchema.index({ donationInterval: 1 });

module.exports = mongoose.model('Wallet', walletSchema);
