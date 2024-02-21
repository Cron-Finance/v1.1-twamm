# Solidity API

## IArbitrageurList

Interface for managing list of addresses permitted to perform preferred rate
        arbitrage swaps on Cron-Fi TWAMM V1.0.

### ListOwnerPermissions

```solidity
event ListOwnerPermissions(address sender, address listOwner, bool permission)
```

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| sender | address | is the address that called the function changing list owner permissions. |
| listOwner | address | is the address to change list owner permissions on. |
| permission | bool | is true if the address specified in listOwner is granted list owner        permissions. Is false otherwise. |

### ArbitrageurPermissions

```solidity
event ArbitrageurPermissions(address sender, address[] arbitrageurs, bool permission)
```

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| sender | address | is the address that called the function changing arbitrageur permissions. |
| arbitrageurs | address[] | is a list of addresses to change arbitrage permissions on. |
| permission | bool | is true if the addresses specified in arbitrageurs is granted        arbitrage permissions. Is false otherwise. |

### NextList

```solidity
event NextList(address sender, address nextListAddress)
```

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| sender | address | is the address that called the function changing the next list address. |
| nextListAddress | address | is the address the return value of the nextList function is set to. |

### isArbitrageur

```solidity
function isArbitrageur(address _address) external returns (bool)
```

Returns true if the provide address is permitted the preferred
        arbitrage rate in the partner swap method of a Cron-Fi TWAMM pool.
        Returns false otherwise.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _address | address | the address to check for arbitrage rate permissions. |

### nextList

```solidity
function nextList() external returns (address)
```

Returns the address of the next contract implementing the next list of arbitrageurs.
        If the return value is the NULL address, address(0), then the TWAMM contract's update
        list method will keep the existing address it is storing to check for arbitrage permissions.

