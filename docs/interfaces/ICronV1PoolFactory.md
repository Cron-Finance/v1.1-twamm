# Solidity API

## ICronV1PoolFactory

### CronV1PoolCreated

```solidity
event CronV1PoolCreated(address pool, address token0, address token1, enum ICronV1PoolEnums.PoolType poolType)
```

This event tracks pool creations from this factory

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| pool | address | the address of the pool |
| token0 | address | The token 0 in this pool |
| token1 | address | The token 1 in this pool |
| poolType | enum ICronV1PoolEnums.PoolType | The poolType set for this pool |

### CronV1PoolSet

```solidity
event CronV1PoolSet(address pool, address token0, address token1, enum ICronV1PoolEnums.PoolType poolType)
```

This event tracks pool being set from this factory

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| pool | address | the address of the pool |
| token0 | address | The token 0 in this pool |
| token1 | address | The token 1 in this pool |
| poolType | enum ICronV1PoolEnums.PoolType | The poolType set for this pool |

### CronV1PoolRemoved

```solidity
event CronV1PoolRemoved(address pool, address token0, address token1, enum ICronV1PoolEnums.PoolType poolType)
```

This event tracks pool deletions from this factory

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| pool | address | the address of the pool |
| token0 | address | The token 0 in this pool |
| token1 | address | The token 1 in this pool |
| poolType | enum ICronV1PoolEnums.PoolType | The poolType set for this pool |

### OwnerChanged

```solidity
event OwnerChanged(address oldAdmin, address newAdmin)
```

This event tracks pool creations from this factory

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| oldAdmin | address | the address of the previous admin |
| newAdmin | address | the address of the new admin |

### create

```solidity
function create(address _token0, address _token1, string _name, string _symbol, uint256 _poolType) external returns (address)
```

### set

```solidity
function set(address _token0, address _token1, uint256 _poolType, address _pool) external
```

### remove

```solidity
function remove(address _token0, address _token1, uint256 _poolType) external
```

### transferOwnership

```solidity
function transferOwnership(address _newOwner, bool _direct, bool _renounce) external
```

### claimOwnership

```solidity
function claimOwnership() external
```

### owner

```solidity
function owner() external view returns (address)
```

### pendingOwner

```solidity
function pendingOwner() external view returns (address)
```

### getPool

```solidity
function getPool(address _token0, address _token1, uint256 _poolType) external view returns (address pool)
```

