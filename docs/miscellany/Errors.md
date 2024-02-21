# Solidity API

## requireErrCode

```solidity
function requireErrCode(bool _condition, uint256 _errorCodeD3) internal pure
```

Reverts if the specified condition is not true with the provided error code.

_WARNING: No checks of _errorCodeD3 are performed for efficiency!_

### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _condition | bool | A condition to test; must resolve to true to not revert. |
| _errorCodeD3 | uint256 | An 3 digit decimal error code to present if the condition                     resolves to false.                     Min. = 0, Max. = 999. |

## CronErrors

### SENDER_NOT_FACTORY

```solidity
uint256 SENDER_NOT_FACTORY
```

### SENDER_NOT_FACTORY_OWNER

```solidity
uint256 SENDER_NOT_FACTORY_OWNER
```

### SENDER_NOT_ADMIN

```solidity
uint256 SENDER_NOT_ADMIN
```

### SENDER_NOT_ARBITRAGE_PARTNER

```solidity
uint256 SENDER_NOT_ARBITRAGE_PARTNER
```

### NON_VAULT_CALLER

```solidity
uint256 NON_VAULT_CALLER
```

### SENDER_NOT_PARTNER

```solidity
uint256 SENDER_NOT_PARTNER
```

### SENDER_NOT_FEE_ADDRESS

```solidity
uint256 SENDER_NOT_FEE_ADDRESS
```

### SENDER_NOT_ORDER_OWNER_OR_DELEGATE

```solidity
uint256 SENDER_NOT_ORDER_OWNER_OR_DELEGATE
```

### CANNOT_TRANSFER_TO_SELF_OR_NULL

```solidity
uint256 CANNOT_TRANSFER_TO_SELF_OR_NULL
```

### RECIPIENT_NOT_OWNER

```solidity
uint256 RECIPIENT_NOT_OWNER
```

### CLEARED_ORDER

```solidity
uint256 CLEARED_ORDER
```

### POOL_PAUSED

```solidity
uint256 POOL_PAUSED
```

### UNSUPPORTED_SWAP_KIND

```solidity
uint256 UNSUPPORTED_SWAP_KIND
```

### INSUFFICIENT_LIQUIDITY

```solidity
uint256 INSUFFICIENT_LIQUIDITY
```

### INCORRECT_POOL_ID

```solidity
uint256 INCORRECT_POOL_ID
```

### ZERO_SALES_RATE

```solidity
uint256 ZERO_SALES_RATE
```

### NO_FUNDS_AVAILABLE

```solidity
uint256 NO_FUNDS_AVAILABLE
```

### MAX_ORDER_LENGTH_EXCEEDED

```solidity
uint256 MAX_ORDER_LENGTH_EXCEEDED
```

### NO_FEES_AVAILABLE

```solidity
uint256 NO_FEES_AVAILABLE
```

### UNSUPPORTED_TOKEN_DECIMALS

```solidity
uint256 UNSUPPORTED_TOKEN_DECIMALS
```

### NULL_RECIPIENT_ON_JOIN

```solidity
uint256 NULL_RECIPIENT_ON_JOIN
```

### CANT_CANCEL_COMPLETED_ORDER

```solidity
uint256 CANT_CANCEL_COMPLETED_ORDER
```

### MINIMUM_NOT_SATISFIED

```solidity
uint256 MINIMUM_NOT_SATISFIED
```

### VALUE_EXCEEDS_CONTAINER_SZ

```solidity
uint256 VALUE_EXCEEDS_CONTAINER_SZ
```

### OVERFLOW

```solidity
uint256 OVERFLOW
```

### UNDERFLOW

```solidity
uint256 UNDERFLOW
```

### PARAM_ERROR

```solidity
uint256 PARAM_ERROR
```

### ZERO_TOKEN_ADDRESSES

```solidity
uint256 ZERO_TOKEN_ADDRESSES
```

### IDENTICAL_TOKEN_ADDRESSES

```solidity
uint256 IDENTICAL_TOKEN_ADDRESSES
```

### EXISTING_POOL

```solidity
uint256 EXISTING_POOL
```

### INVALID_FACTORY_OWNER

```solidity
uint256 INVALID_FACTORY_OWNER
```

### INVALID_PENDING_OWNER

```solidity
uint256 INVALID_PENDING_OWNER
```

### NON_EXISTING_POOL

```solidity
uint256 NON_EXISTING_POOL
```

### P_ETH_TRANSFER

```solidity
uint256 P_ETH_TRANSFER
```

### P_NULL_USER_ADDRESS

```solidity
uint256 P_NULL_USER_ADDRESS
```

### P_INSUFFICIENT_LIQUIDITY

```solidity
uint256 P_INSUFFICIENT_LIQUIDITY
```

### P_INSUFFICIENT_TOKEN_A_USER_BALANCE

```solidity
uint256 P_INSUFFICIENT_TOKEN_A_USER_BALANCE
```

### P_INSUFFICIENT_TOKEN_B_USER_BALANCE

```solidity
uint256 P_INSUFFICIENT_TOKEN_B_USER_BALANCE
```

### P_INVALID_POOL_TOKEN_AMOUNT

```solidity
uint256 P_INVALID_POOL_TOKEN_AMOUNT
```

### P_INSUFFICIENT_POOL_TOKEN_USER_BALANCE

```solidity
uint256 P_INSUFFICIENT_POOL_TOKEN_USER_BALANCE
```

### P_INVALID_INTERVAL_AMOUNT

```solidity
uint256 P_INVALID_INTERVAL_AMOUNT
```

### P_DELEGATE_WITHDRAW_RECIPIENT_NOT_OWNER

```solidity
uint256 P_DELEGATE_WITHDRAW_RECIPIENT_NOT_OWNER
```

### P_INVALID_OR_EXPIRED_ORDER_ID

```solidity
uint256 P_INVALID_OR_EXPIRED_ORDER_ID
```

### P_WITHDRAW_BY_ORDER_OR_DELEGATE_ONLY

```solidity
uint256 P_WITHDRAW_BY_ORDER_OR_DELEGATE_ONLY
```

### P_DELEGATE_CANCEL_RECIPIENT_NOT_OWNER

```solidity
uint256 P_DELEGATE_CANCEL_RECIPIENT_NOT_OWNER
```

### P_CANCEL_BY_ORDER_OR_DELEGATE_ONLY

```solidity
uint256 P_CANCEL_BY_ORDER_OR_DELEGATE_ONLY
```

### P_INVALID_TOKEN_IN_ADDRESS

```solidity
uint256 P_INVALID_TOKEN_IN_ADDRESS
```

### P_INVALID_TOKEN_OUT_ADDRESS

```solidity
uint256 P_INVALID_TOKEN_OUT_ADDRESS
```

### P_INVALID_POOL_TYPE

```solidity
uint256 P_INVALID_POOL_TYPE
```

### P_NON_EXISTING_POOL

```solidity
uint256 P_NON_EXISTING_POOL
```

### P_INVALID_POOL_ADDRESS

```solidity
uint256 P_INVALID_POOL_ADDRESS
```

### P_INVALID_AMOUNT_IN

```solidity
uint256 P_INVALID_AMOUNT_IN
```

### P_INSUFFICIENT_TOKEN_IN_USER_BALANCE

```solidity
uint256 P_INSUFFICIENT_TOKEN_IN_USER_BALANCE
```

### P_POOL_HAS_NO_LIQUIDITY

```solidity
uint256 P_POOL_HAS_NO_LIQUIDITY
```

### P_MAX_ORDER_LENGTH_EXCEEDED

```solidity
uint256 P_MAX_ORDER_LENGTH_EXCEEDED
```

### P_NOT_IMPLEMENTED

```solidity
uint256 P_NOT_IMPLEMENTED
```

### P_MULTICALL_NOT_SUPPORTED

```solidity
uint256 P_MULTICALL_NOT_SUPPORTED
```

