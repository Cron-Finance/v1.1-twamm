# Solidity API

## CronV1Relayer

A periphery contract for the Cron-Fi V1 Time-Weighted Average Market Maker (TWAMM) pools built
        upon Balancer Vault. While this contract's interface to the Cron-Fi TWAMM pools increases gas use,
        it provides reasonable safety checks on behalf of the user that the core contract does not. It is also
        convenient for users within Etherscan, Gnosis Safe and other contract web interfaces, eliminating the need
        for the construction of complex Solidity data types that are cumbersome in that environment.

        For usage details, see the online Cron-Fi documentation at https://docs.cronfi.com/.

        IMPORTANT: Users must approve this contract on the Balancer Vault before any transactions can be used.
                   This can be done by calling setRelayerApproval on the Balancer Vault contract and specifying
                   this contract's address.

### constructor

```solidity
constructor(contract IVault _vault, address _libraryAddress, contract ICronV1PoolFactory _factory) public
```

Creates an instance of the Cron-Fi Time-Weighted Average Market Maker (TWAMM) periphery relayer
        contract.

_IMPORTANT: This contract is not meant to be deployed directly by an EOA, but rather during construction
                of a library contract derived from `BaseRelayerLibrary`, which will provide its own address
                as this periphery relayer's library address, LIB_ADDR._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _vault | contract IVault | is the Balancer Vault instance this periphery relayer contract services. |
| _libraryAddress | address | is the address of the library contract this periphery relayer uses to interact                        with the Vault instance. Note as mentioned above in the "dev" note, the library contract                        is instantiated first and then constructs this contract with its address, _libraryAddress,                        as an argument. |
| _factory | contract ICronV1PoolFactory | is the Cron-Fi factory contract instance. |

### receive

```solidity
receive() external payable
```

Do not accept ETH transfers from anyone. The relayer and Cron-Finance Time Weighted Average Market
        Maker (TWAMM) pools do not work with raw ETH.

        NOTE: Unlike other Balancer relayer examples, the refund ETH functionality has been removed to prevent
              self-destruct attacks, causing transactions to revert, since Cron-Finance TWAMM doesn't support
              raw ETH.

### swap

```solidity
function swap(address _tokenIn, address _tokenOut, uint256 _poolType, uint256 _amountIn, uint256 _minTokenOut, address _recipient) external returns (bytes swapResult)
```

see documentation in ICronV1Relayer.sol

### join

```solidity
function join(address _tokenA, address _tokenB, uint256 _poolType, uint256 _liquidityA, uint256 _liquidityB, uint256 _minLiquidityA, uint256 _minLiquidityB, address _recipient) external returns (bytes joinResult)
```

see documentation in ICronV1Relayer.sol

### exit

```solidity
function exit(address _tokenA, address _tokenB, uint256 _poolType, uint256 _numLPTokens, uint256 _minAmountOutA, uint256 _minAmountOutB, address _recipient) external returns (bytes exitResult)
```

see documentation in ICronV1Relayer.sol

### longTermSwap

```solidity
function longTermSwap(address _tokenIn, address _tokenOut, uint256 _poolType, uint256 _amountIn, uint256 _intervals, address _delegate) external returns (bytes longTermSwapResult, uint256 orderId)
```

see documentation in ICronV1Relayer.sol

### withdraw

```solidity
function withdraw(address _tokenA, address _tokenB, uint256 _poolType, uint256 _orderId, address _recipient) external returns (bytes withdrawResult)
```

see documentation in ICronV1Relayer.sol

### cancel

```solidity
function cancel(address _tokenA, address _tokenB, uint256 _poolType, uint256 _orderId, address _recipient) external returns (bytes cancelResult)
```

see documentation in ICronV1Relayer.sol

### getVault

```solidity
function getVault() external view returns (contract IVault)
```

see documentation in ICronV1Relayer.sol

### getLibrary

```solidity
function getLibrary() external view returns (address)
```

see documentation in ICronV1Relayer.sol

### getPoolAddress

```solidity
function getPoolAddress(address _tokenA, address _tokenB, uint256 _poolType) external view returns (address pool)
```

see documentation in ICronV1Relayer.sol

### getOrder

```solidity
function getOrder(address _tokenA, address _tokenB, uint256 _poolType, uint256 _orderId) external view returns (address pool, struct Order order)
```

see documentation in ICronV1Relayer.sol

