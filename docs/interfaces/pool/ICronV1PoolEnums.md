# Solidity API

## ICronV1PoolEnums

### PoolType

```solidity
enum PoolType {
  Stable,
  Liquid,
  Volatile
}
```

### JoinType

```solidity
enum JoinType {
  Join,
  Reward
}
```

### SwapType

```solidity
enum SwapType {
  RegularSwap,
  LongTermSwap,
  PartnerSwap
}
```

### ExitType

```solidity
enum ExitType {
  Exit,
  Withdraw,
  Cancel,
  FeeWithdraw
}
```

### ParamType

```solidity
enum ParamType {
  SwapFeeFP,
  PartnerFeeFP,
  LongSwapFeeFP
}
```

### BoolParamType

```solidity
enum BoolParamType {
  Paused,
  CollectBalancerFees
}
```

