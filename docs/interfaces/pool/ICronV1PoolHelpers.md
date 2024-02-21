# Solidity API

## ICronV1PoolHelpers

### getVirtualPriceOracle

```solidity
function getVirtualPriceOracle(uint256 _maxBlock) external returns (uint256 timestamp, uint256 token0U256F112, uint256 token1U256F112, uint256 blockNumber)
```

### getVirtualReserves

```solidity
function getVirtualReserves(uint256 _maxBlock, bool _paused) external returns (uint256 blockNumber, uint256 token0ReserveU112, uint256 token1ReserveU112, uint256 token0OrdersU112, uint256 token1OrdersU112, uint256 token0ProceedsU112, uint256 token1ProceedsU112, uint256 token0BalancerFeesU96, uint256 token1BalancerFeesU96, uint256 token0CronFiFeesU96, uint256 token1CronFiFeesU96)
```

### POOL_ID

```solidity
function POOL_ID() external view returns (bytes32)
```

### POOL_TYPE

```solidity
function POOL_TYPE() external view returns (enum ICronV1PoolEnums.PoolType)
```

### getPriceOracle

```solidity
function getPriceOracle() external view returns (uint256 timestamp, uint256 token0U256F112, uint256 token1U256F112)
```

### getOrderIds

```solidity
function getOrderIds(address _owner, uint256 _offset, uint256 _maxResults) external view returns (uint256[] orderIds, uint256 numResults, uint256 totalResults)
```

### getOrder

```solidity
function getOrder(uint256 _orderId) external view returns (struct Order order)
```

### getOrderIdCount

```solidity
function getOrderIdCount() external view returns (uint256 nextOrderId)
```

### getSalesRates

```solidity
function getSalesRates() external view returns (uint256 salesRate0U112, uint256 salesRate1U112)
```

### getLastVirtualOrderBlock

```solidity
function getLastVirtualOrderBlock() external view returns (uint256 lastVirtualOrderBlock)
```

### getSalesRatesEndingPerBlock

```solidity
function getSalesRatesEndingPerBlock(uint256 _blockNumber) external view returns (uint256 salesRateEndingPerBlock0U112, uint256 salesRateEndingPerBlock1U112)
```

### getShortTermFeePoints

```solidity
function getShortTermFeePoints() external view returns (uint256)
```

### getPartnerFeePoints

```solidity
function getPartnerFeePoints() external view returns (uint256)
```

### getLongTermFeePoints

```solidity
function getLongTermFeePoints() external view returns (uint256)
```

### getOrderAmounts

```solidity
function getOrderAmounts() external view returns (uint256 orders0U112, uint256 orders1U112)
```

### getProceedAmounts

```solidity
function getProceedAmounts() external view returns (uint256 proceeds0U112, uint256 proceeds1U112)
```

### getFeeShift

```solidity
function getFeeShift() external view returns (uint256)
```

### getCronFeeAmounts

```solidity
function getCronFeeAmounts() external view returns (uint256 cronFee0U96, uint256 cronFee1U96)
```

### isPaused

```solidity
function isPaused() external view returns (bool)
```

### isCollectingCronFees

```solidity
function isCollectingCronFees() external view returns (bool)
```

### isCollectingBalancerFees

```solidity
function isCollectingBalancerFees() external view returns (bool)
```

### getBalancerFee

```solidity
function getBalancerFee() external view returns (uint256)
```

### getBalancerFeeAmounts

```solidity
function getBalancerFeeAmounts() external view returns (uint256 balFee0U96, uint256 balFee1U96)
```

