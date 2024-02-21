# Solidity API

## Order

```solidity
struct Order {
  bool token0To1;
  uint112 salesRate;
  uint128 scaledProceedsAtSubmissionU128;
  address owner;
  address delegate;
  uint256 orderExpiry;
}
```

## OrderPools

```solidity
struct OrderPools {
  uint256 currentSalesRates;
  uint256 scaledProceeds;
  mapping(uint256 => uint256) salesRatesEndingPerBlock;
}
```

## VirtualOrders

```solidity
struct VirtualOrders {
  struct OrderPools orderPools;
  mapping(uint256 => uint256) scaledProceedsAtBlock;
  mapping(uint256 => struct Order) orderMap;
  uint256 lastVirtualOrderBlock;
  uint256 nextOrderId;
}
```

## PriceOracle

```solidity
struct PriceOracle {
  uint256 token0U256F112;
  uint256 token1U256F112;
}
```

## ExecVirtualOrdersMem

```solidity
struct ExecVirtualOrdersMem {
  uint256 token0ReserveU112;
  uint256 token1ReserveU112;
  uint256 lpFeeU60;
  uint256 feeShareU60;
  uint256 feeShiftU3;
  uint256 token0BalancerFeesU96;
  uint256 token1BalancerFeesU96;
  uint256 token0CronFiFeesU96;
  uint256 token1CronFiFeesU96;
  uint256 token0OrdersU112;
  uint256 token1OrdersU112;
  uint256 token0ProceedsU112;
  uint256 token1ProceedsU112;
  uint256 token0OracleU256F112;
  uint256 token1OracleU256F112;
}
```

## LoopMem

```solidity
struct LoopMem {
  uint256 lastVirtualOrderBlock;
  uint256 scaledProceeds0U128;
  uint256 scaledProceeds1U128;
  uint256 currentSalesRate0U112;
  uint256 currentSalesRate1U112;
}
```

