# Solidity API

## ASSET_IN

```solidity
uint256 ASSET_IN
```

## ASSET_OUT

```solidity
uint256 ASSET_OUT
```

## FIVE_MIN_IN_SEC

```solidity
uint256 FIVE_MIN_IN_SEC
```

## ZERO_PCT_BP

```solidity
uint256 ZERO_PCT_BP
```

## TEN_PCT_BP

```solidity
uint256 TEN_PCT_BP
```

## MAX_BP

```solidity
uint256 MAX_BP
```

## CronV1Actions

Cron-Fi specific periphery relayer functionality for performing Time Weighted
        Average Market Maker (TWAMM) pool actions on a pool with some safety and convenience
        checks.

_The periphery relayer is composed of two contracts:
       - The CronV1Relayer contract, which acts as the point of entry into the system through
         convenience functions and a multicall function.
       - This library contract that defines the behaviors and checks allowed by the periphery
         relayer.

There are unchecked operations (this code targets Solidity 0.7.x which
     didn't yet feature implicit arithmetic checks or have the 'unchecked' block feature)
     herein for reasons of efficiency or desired overflow. Wherever they appear they will
     be documented and accompanied with one of the following tags:
       - #unchecked
       - #overUnderFlowIntended

NOTE: Only the entrypoint contract should be allowlisted by Balancer governance as a relayer,
      so that the Vault will reject calls from outside the entrypoint context.

WARNING: This contract should neither be allowlisted as a relayer, nor called directly by the
         user. No guarantees can be made about fund safety when calling this contract in an
         improper manner._

### constructor

```solidity
constructor(contract IVault _vault, contract ICronV1PoolFactory _factory) public
```

Creates an instance of the library contract and periphery relayer contract for
        convenient interactions with Cron-Fi TWAMM pools. The periphery relayer
        contract is created by this constructor and should not be separately be created.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _vault | contract IVault | is the Balancer Vault instance this periphery relayer system services. |
| _factory | contract ICronV1PoolFactory | is the Cron-Fi factory contract instance. |

### swap

```solidity
function swap(address _tokenIn, uint256 _amountIn, address _tokenOut, uint256 _minTokenOut, uint256 _poolType, address _caller, address _recipient) external returns (uint256 amountOut)
```

see swap documentation in ICronV1Relayer.sol, except noted differences below:

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _tokenIn | address |  |
| _amountIn | uint256 |  |
| _tokenOut | address |  |
| _minTokenOut | uint256 |  |
| _poolType | uint256 |  |
| _caller | address | is the address of the user that called the CronV1Relayer swap function.                It is explicitly passed here because the function calls the multicall                function, which delegate calls this method (msg.sender would be the relayer                contract address and not this one). |
| _recipient | address |  |

### join

```solidity
function join(address _tokenA, address _tokenB, uint256 _poolType, uint256 _liquidityA, uint256 _liquidityB, uint256 _minLiquidityA, uint256 _minAmountOutB, address _caller, address _recipient) external
```

see join documentation in ICronV1Relayer.sol, except noted differences below:

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _tokenA | address |  |
| _tokenB | address |  |
| _poolType | uint256 |  |
| _liquidityA | uint256 |  |
| _liquidityB | uint256 |  |
| _minLiquidityA | uint256 |  |
| _minAmountOutB | uint256 |  |
| _caller | address | is the address of the user that called the CronV1Relayer join function.                It is explicitly passed here because the function calls the multicall                function, which delegate calls this method (msg.sender would be the relayer                contract address and not this one). |
| _recipient | address |  |

### exit

```solidity
function exit(address _tokenA, address _tokenB, uint256 _poolType, uint256 _numLPTokens, uint256 _minAmountOutA, uint256 _minAmountOutB, address _caller, address _recipient) external
```

see exit documentation in ICronV1Relayer.sol, except noted differences below:

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _tokenA | address |  |
| _tokenB | address |  |
| _poolType | uint256 |  |
| _numLPTokens | uint256 |  |
| _minAmountOutA | uint256 |  |
| _minAmountOutB | uint256 |  |
| _caller | address | is the address of the user that called the CronV1Relayer exit function.                It is explicitly passed here because the function calls the multicall                function, which delegate calls this method (msg.sender would be the relayer                contract address and not this one). |
| _recipient | address |  |

### longTermSwap

```solidity
function longTermSwap(address _tokenIn, address _tokenOut, uint256 _poolType, uint256 _amountIn, uint256 _intervals, address _owner, address _delegate) external
```

see longTermSwap documentation in ICronV1Relayer.sol, except noted differences below:

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _tokenIn | address |  |
| _tokenOut | address |  |
| _poolType | uint256 |  |
| _amountIn | uint256 |  |
| _intervals | uint256 |  |
| _owner | address | is the address of the user that called the CronV1Relayer longTermSwap function.               It is explicitly passed here because the function calls the multicall               function, which delegate calls this method (msg.sender would be the relayer               contract address and not this one). |
| _delegate | address |  |

### withdraw

```solidity
function withdraw(address _tokenA, address _tokenB, uint256 _poolType, uint256 _orderId, address _caller, address _recipient) external
```

see withdraw documentation in ICronV1Relayer.sol, except noted differences below:

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _tokenA | address |  |
| _tokenB | address |  |
| _poolType | uint256 |  |
| _orderId | uint256 |  |
| _caller | address | is the address of the user that called the CronV1Relayer withdraw function.                It is explicitly passed here because the function calls the multicall                function, which delegate calls this method (msg.sender would be the relayer                contract address and not this one). |
| _recipient | address |  |

### cancel

```solidity
function cancel(address _tokenA, address _tokenB, uint256 _poolType, uint256 _orderId, address _caller, address _recipient) external
```

cancel see documentation in ICronV1Relayer.sol, except noted differences below:

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _tokenA | address |  |
| _tokenB | address |  |
| _poolType | uint256 |  |
| _orderId | uint256 |  |
| _caller | address | is the address of the user that called the CronV1Relayer cancel function.                It is explicitly passed here because the function calls the multicall                function, which delegate calls this method (msg.sender would be the relayer                contract address and not this one). |
| _recipient | address |  |

### getVault

```solidity
function getVault() public view returns (contract IVault)
```

Gets the Balancer Vault instance this periphery relayer library is servicing.

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| [0] | contract IVault | a Balancer Vault instance. |

### getEntrypoint

```solidity
function getEntrypoint() public view returns (contract ICronV1Relayer)
```

Gets the periphery relayer contract instantiated by this library, that serves as
        the user relayer entrypoint to Cron-Fi Time-Weighted Average Market Maker (TWAMM)
        pools.

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| [0] | contract ICronV1Relayer | a instance of the Cron-Fi Relayer serving as an entry point to this library. |

### getFactory

```solidity
function getFactory() public view returns (contract ICronV1PoolFactory)
```

Gets the Cron-Fi Time-Weighted Average Market Maker (TWAMM) factory contract
        instance used by this periphery relayer library to select Cron-Fi TWAMM pools.

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| [0] | contract ICronV1PoolFactory | a Cron-Fi TWAMM factory instance. |

### _getPoolInfoAndCheckValid

```solidity
function _getPoolInfoAndCheckValid(address _tokenIn, address _tokenOut, uint256 _poolType) internal view returns (address pool, bytes32 poolId)
```

Gets the Balancer pool address and pool id for the provided token addresses and pool type,
        if available. Reverts if the pool is not available with the reason why if possible.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _tokenIn | address | the address of the token being sold to the pool by the calling account. |
| _tokenOut | address | the address of the token being bought from the pool by the calling account. |
| _poolType | uint256 | a number mapping to the PoolType enumeration (see ICronV1PoolEnums.sol::PoolType for the                  enumeration definition):                  Stable = 0                  Liquid = 1                  Volatile = 2                  Min. = 0, Max. = 2 |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| pool | address | the address of the unique Cron-Fi pool for the provided token addresses and pool type. |
| poolId | bytes32 | the Balancer pool id corresponding to the returned pool address. |

### _checkAmountIn

```solidity
function _checkAmountIn(uint256 _amountIn, address _tokenIn, address _account) internal view
```

Checks the amount of token being sold by the user to the pool is within acceptable bounds, reverts
        otherwise. Also confirms that the user has sufficient amount of that token available in their
        account, reverts otherwise.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _amountIn | uint256 | is the user specified amount of a token to sell to the pool in a long-term or regular swap.                  Min. = 0, Max. = (2**112) - 1 |
| _tokenIn | address | the address of the token being sold to the pool by the user. |
| _account | address | the address of the user selling the token to the pool. |

### _getPoolAssetsAndCheckBalances

```solidity
function _getPoolAssetsAndCheckBalances(bytes32 _poolId, address _tokenIn) internal view returns (contract IAsset[] assetInOut)
```

Gets the tokens and balances for the pool specified by the pool id. Checks to ensure
        the balances are greater than the MINIMUM_LIQUIDITY constraint (reverts otherwise).
        Converts the token instances fetched from the pool into a sorted array of Asset instances;
        the sort order is that Asset instance 0 (the first instance) corresponds to the address
        specified for token in. Asset instance 1 (the second instance) corresponds to the address
        specified for token out (there's only two assets in all these pools).

        For convenience and clarity, the array of Asset instances should be indexed with the
        provided constants ASSET_IN (0) and ASSET_OUT (1).

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _poolId | bytes32 | the Balancer pool id for the pool to fetch tokens and balances of. |
| _tokenIn | address | the address of the token being sold to the pool by the user. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| assetInOut | contract IAsset[] | an array of Asset instances for the pool corresponding to pool id sorted                    in the order of token in to token out. See notice above for more details. |

### _getEffectiveAmountInAndCheckIntervals

```solidity
function _getEffectiveAmountInAndCheckIntervals(uint256 _amountIn, uint256 _orderIntervals, enum ICronV1PoolEnums.PoolType _poolType) internal view returns (uint256 effectiveAmountIn)
```

This method computes the effective amount of an order that the pool can process for
        a long-term swap verses a user specified amount. The difference between the two values
        results from a truncation error due to division of the user specified amount by the
        trade length. Losses due to this truncation are multiplied by the trade length.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _amountIn | uint256 | is the user specified amount of a token to sell to the pool in a long-term swap.                  Min. = 0, Max. = (2**112) - 1 |
| _orderIntervals | uint256 | is the length of the long-term swap in order block intervals (OBI). |
| _poolType | enum ICronV1PoolEnums.PoolType |  |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| effectiveAmountIn | uint256 | is the amount of the user specified order amount that would be sold to                           to the pool for the opposing token and not lost due to truncation.                           Min. = 0, Max. = (2**112) - 1 |

### _getDeadline

```solidity
function _getDeadline() internal view returns (uint256 deadline)
```

Gets a deadline timestamp--a timestamp in the future used to cue the Balancer Vault to
        ignore a transaction that has sat in the mempool for an excessive amount of time.

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| deadline | uint256 | the current block timestamp plus five minutes (in seconds). |

### _getPoolAssets

```solidity
function _getPoolAssets(bytes32 _poolId) internal view returns (contract IAsset[] assets)
```

Gets the pool's Asset instances in Balancer token sort order given the Balancer pool id.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _poolId | bytes32 | the Balancer pool id for the pool to fetch tokens to be converted to asset instances. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| assets | contract IAsset[] | an array of ERC 20 token instances converted to Asset instances. |

### _convertERC20sToAssets

```solidity
function _convertERC20sToAssets(contract IERC20[] _tokens) internal pure returns (contract IAsset[] assets)
```

Converts an array of ERC20 instances to Asset instances.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _tokens | contract IERC20[] | an array of ERC20 token instances to convert to Asset instances. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| assets | contract IAsset[] | an array of ERC 20 token instances converted to Asset instances. |

