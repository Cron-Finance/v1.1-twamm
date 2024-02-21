# Solidity API

## ICronV1PoolEvents

### ShortTermSwap

```solidity
event ShortTermSwap(address sender, address tokenIn, uint256 amountIn, uint256 amountOut, uint256 swapType)
```

ShortTermSwap event is emitted for Short-Term (ST) swap transactions and
        arbitrage partner ST swap transactions. To differentiate, examine the value of
        swapType in the emitted event.

### LongTermSwap

```solidity
event LongTermSwap(address sender, address delegate, address tokenIn, uint256 amountIn, uint256 intervals, uint256 orderId)
```

LongTermSwap event is emitted when Long-Term (LT) swaps transaction are issued to
        the pool.

### PoolJoin

```solidity
event PoolJoin(address sender, address recipient, uint256 token0In, uint256 token1In, uint256 poolTokenAmt)
```

PoolJoin events are emitted for Join/Mint and Reward transactions. A Reward
        transaction can be identified from a Join/Mint transaction by examining the
        emitted event's poolTokenAmt to see if is zero.

### WithdrawLongTermSwap

```solidity
event WithdrawLongTermSwap(address owner, address refundToken, uint256 refundOut, address proceedsToken, uint256 proceedsOut, uint256 orderId, address sender)
```

WithdrawLongTermSwap events are emitted when an LT swap order is withdrawn or cancelled
        in a transaction. To differentiate between the two, only a cancellation will have non-zero
        values for refundOut.

### FeeWithdraw

```solidity
event FeeWithdraw(address sender, uint256 token0Out, uint256 token1Out)
```

FeeWithdraw events are emitted when Cron-Fi fees are withdrawn from the pool.

### PoolExit

```solidity
event PoolExit(address sender, uint256 poolTokenAmt, uint256 token0Out, uint256 token1Out)
```

PoolExit events are emitted when a Liquidity Provider (LP) redeems LP tokens for
        their share of tokens remaining in the pool.

### AdministratorStatusChange

```solidity
event AdministratorStatusChange(address sender, address admin, bool status)
```

AdministratorStatusChange events are emitted when an administrator address, admin,
        is given administrator privileges (status == true) or when they are taken away
        (status == false).

### ProtocolFeeTooLarge

```solidity
event ProtocolFeeTooLarge(uint256 suggestedProtocolFee)
```

ProtocolFeeTooLarge is emitted if the protocol fee passed in by balancer ever exceeds
        1e18 (in which case the change is ignored and fees continue with the last good value).

### ParameterChange

```solidity
event ParameterChange(address sender, enum ICronV1PoolEnums.ParamType paramType, uint256 value)
```

ParameterChange is emitted when a parameter value is changed to value. Consult the
        enum ParmType for the parameter undergoing change.

### FeeAddressChange

```solidity
event FeeAddressChange(address sender, address feeAddress)
```

FeeAddressChange is emitted when the fee address, feeAddress, is changed.

### FeeShiftChange

```solidity
event FeeShiftChange(address sender, uint256 feeShift)
```

FeeShiftChange is emitted when the fee shift, feeShift is changed.

### BoolParameterChange

```solidity
event BoolParameterChange(address sender, enum ICronV1PoolEnums.BoolParamType boolParam, bool value)
```

BoolParameterChange is emitted when a boolean value parameter is changed. Consult the
        enum BoolParmType for the parameter undergoing change.

### UpdatedArbitragePartner

```solidity
event UpdatedArbitragePartner(address sender, address partner, address list)
```

UpdatedArbitragePartner is emitted when an arbitrage partner's arbitrageur list is
        updated to a new contract address.

### UpdatedArbitrageList

```solidity
event UpdatedArbitrageList(address partner, address oldList, address newList)
```

UpdatedArbitrageList is emitted when an arbitrage partner's updates their arbitrageur
        list is to a new contract address through the updateArbitrageList function.

### ExecuteVirtualOrdersEvent

```solidity
event ExecuteVirtualOrdersEvent(address sender, uint256 block)
```

ExecuteVirtualOrdersEvent is emitted on calls to executeVirtualOrdersToBlock.

