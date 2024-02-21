# Solidity API

## CronV1PoolFactory

### owner

```solidity
address owner
```

### pendingOwner

```solidity
address pendingOwner
```

### poolMap

```solidity
mapping(address => mapping(address => mapping(uint256 => address))) poolMap
```

### onlyOwner

```solidity
modifier onlyOwner()
```

Only allows the `owner` to execute the function.

### constructor

```solidity
constructor(contract IVault _vault) public
```

This function constructs the pool

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _vault | contract IVault | The balancer v2 vault |

### create

```solidity
function create(address _token0, address _token1, string _name, string _symbol, uint256 _poolType) external returns (address)
```

Deploys a new `CronV1Pool`

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _token0 | address | The asset which is converged to ie "base' |
| _token1 | address | The asset which converges to the underlying |
| _name | string | The name of the balancer v2 lp token for this pool |
| _symbol | string | The symbol of the balancer v2 lp token for this pool |
| _poolType | uint256 | The type of pool (stable, liquid, volatile) |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| [0] | address | The new pool address |

### set

```solidity
function set(address _token0, address _token1, uint256 _poolType, address _pool) external
```

Sets `CronV1Pool` address in the mapping

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _token0 | address | address of token0 |
| _token1 | address | address of token1 |
| _poolType | uint256 | type of pool (stable, liquid, volatile) |
| _pool | address | address of pool to set in the mapping |

### remove

```solidity
function remove(address _token0, address _token1, uint256 _poolType) external
```

Removes an already deployed `CronV1Pool` from the mapping
        WARNING - Best practice to disable Cron-Fi fees before
        removing it from the factory pool mapping. Also advisable
        to notify LPs / LT swappers in some way that this is
        occurring.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _token0 | address | address of token0 |
| _token1 | address | address of token1 |
| _poolType | uint256 | type of pool (stable, liquid, volatile) |

### transferOwnership

```solidity
function transferOwnership(address _newOwner, bool _direct, bool _renounce) external
```

Transfers ownership to `_newOwner`. Either directly or claimable by the new pending owner.
Can only be invoked by the current `owner`.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _newOwner | address | Address of the new owner. |
| _direct | bool | True if `_newOwner` should be set immediately. False if `_newOwner` needs to use `claimOwnership`. |
| _renounce | bool | Allows the `_newOwner` to be `address(0)` if `_direct` and `_renounce` is True. Has no effect otherwise. |

### claimOwnership

```solidity
function claimOwnership() external
```

Needs to be called by `pendingOwner` to claim ownership.

### getPool

```solidity
function getPool(address _token0, address _token1, uint256 _poolType) external view returns (address)
```

Gets existing pool for given address pair post sort and pool type

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _token0 | address | address of token 0 |
| _token1 | address | address of token 1 |
| _poolType | uint256 | type of pool |

