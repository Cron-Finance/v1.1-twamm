# Solidity API

## NULL_ADDR

```solidity
address NULL_ADDR
```

## ArbitrageurListExample

Abstract contract for managing list of addresses permitted to perform preferred rate
        arbitrage swaps on Cron-Fi TWAMM V1.0.

_In Cron-Fi TWAMM V1.0 pools, the partner swap (preferred rate arbitrage swap) may only
        be successfully called by an address that returns true when isArbitrageur in a contract
        derived from this one (the caller must also specify the address of the arbitrage partner
        to facilitate a call to isArbitrageur in the correct contract).

   Two mechanisms are provided for updating the arbitrageur list, they are:
            - The setArbitrageurs method, which allows a list of addresses to
              be given or removed arbitrage permission.
            - The nextList mechanism. In order to use this mechanism, a new contract deriving
              from this contract with new arbitrage addresses specified must be deployed.
              A listOwner then sets the nextList address to the newly deployed contract
              address with the setNextList method.
              Finally, the arbPartner address in the corresponding Cron-Fi TWAMM contract will
              then call updateArbitrageList to retrieve the new arbitrageur list contract address
              from this contract instance. Note that all previous arbitraguer contracts in the TWAMM
              contract using the updated list are ignored.

   Note that this is a bare-bones implementation without conveniences like a list to
        inspect all current arbitraguer addresses at once (emitted events can be consulted and
        aggregated off-chain for this purpose), however users are encouraged to modify the contract
        as they wish as long as the following methods continue to function as specified:
            - isArbitrageur_

### nextList

```solidity
address nextList
```

Returns the address of the next contract implementing the next list of arbitrageurs.
        If the return value is the NULL address, address(0), then the TWAMM contract's update
        list method will keep the existing address it is storing to check for arbitrage permissions.

### senderIsListOwner

```solidity
modifier senderIsListOwner()
```

### constructor

```solidity
constructor(address[] _arbitrageurs) public
```

Constructs this contract with next contract and the specified list of addresses permitted
        to arbitrage.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _arbitrageurs | address[] | is a list of addresses to give arbitrage permission to on contract instantiation. |

### setListOwner

```solidity
function setListOwner(address _address, bool _permitted) public
```

Sets whether or not a specified address is a list owner.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _address | address | is the address to give or remove list owner priviliges from. |
| _permitted | bool | if true, gives the specified address list owner priviliges. If false        removes list owner priviliges. |

### setArbitrageurs

```solidity
function setArbitrageurs(address[] _arbitrageurs, bool _permitted) public
```

Sets whether the specified list of addresses is permitted to arbitrage Cron-Fi TWAMM
        pools at a preffered rate or not.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _arbitrageurs | address[] | is a list of addresses to add or remove arbitrage permission from. |
| _permitted | bool | specifies if the list of addresses contained in _arbitrageurs will be given        arbitrage permission when set to true. When false, arbitrage permission is removed from        the specified addresses. |

### setNextList

```solidity
function setNextList(address _address) public
```

Sets the next contract address to use for arbitraguer permissions. Requires that the
        contract be instantiated and that a call to updateArbitrageList is made by the
        arbitrage partner list on the corresponding TWAMM pool.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _address | address | is the address of the instantiated contract deriving from this contract to        use for address arbitrage permissions. |

### isListOwner

```solidity
function isListOwner(address _address) public view returns (bool)
```

Returns true if specified address has list owner permissions.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _address | address | is the address to check for list owner permissions. |

### isArbitrageur

```solidity
function isArbitrageur(address _address) public view returns (bool)
```

Returns true if the provide address is permitted the preferred
        arbitrage rate in the partner swap method of a Cron-Fi TWAMM pool.
        Returns false otherwise.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _address | address | the address to check for arbitrage rate permissions. |

