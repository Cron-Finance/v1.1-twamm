# Solidity API

## CronV1Pool

For usage details, see the online Cron-Fi documentation at https://docs.cronfi.com/.

_Uses Balancer math library for overflow/underflow checks on standard U256 containers.
     However, as many custom representations are used (i.e. non native word lengths) there
     are a number of explicit checks against the maximum of other word lengths.
     Furthermore there are unchecked operations (this code targets Solidity 0.7.x which
     didn't yet feature implicit arithmetic checks or have the 'unchecked' block feature)
     herein for reasons of efficiency or desired overflow. Wherever they appear they will
     be documented and accompanied with one of the following tags:
       - #unchecked
       - #overUnderFlowIntended
     Identified risks will be accompanied and described with the following tag:
       - #RISK

Conventions in the methods, variables and constants are as follows:

     Prefixes:

     - In constants, the prefix "Sn", where 1 <= n <= 4, denotes which slot the constant
       pertains too. There are four storage slots that are bitpacked. For example,
       "S2_OFFSET_ORACLE_TIMESTAMP" refers to the offset of the oracle timestamp in bit-
       packed storage slot 2.

     Suffixes:

     - The suffix of a variable name denotes the type contained within the variable.
       For instance "uint256 _incrementU96" is a 256-bit unsigned container representing
       the 96-bit value "_increment".
       In the case of "uint256 _balancerFeeDU1F18", the 256-bit unsigned container is
       representing a 19 digit decimal value with 18 fractional digits. In this scenario,
       the D=Decimal, U=Unsigned, F=Fractional.
       Finally, "uint128 valueU128F64" is a 128-bit container representing a 128-bit value
       with 64 fractional bits.

     - The suffix of a function name denotes what slot it is proprietary too as a
       matter of convention. While unchecked at run-time or by the compiler, the naming
       convention easily aids in understanding what slot a packed value is stored within.
       For instance the function "unpackFeeShiftS3" unpacks the fee shift from slot 3.
       If the value of slot 2 were passed to this method, the unpacked value would be
       incorrect.

Fee Points (FP) is a system used herein to calculate applicable fees. THESE ABSOLUTELY
     SHOULD NOT BE CONFUSED WITH BASIS POINTS--THEY ARE NOT BASIS POINTS! It consists of
     fees, such as a swap fee, expressed in FP. The swap fee is multiplied by the amount
     of token being swapped and divided by the total fee points (TOTAL_FP), which is 100,000,
     to obtain the fee. For instance, a swap fee of 0.050% can be realized as follows:

                   token_in x FEE_BP
        swap_fee = -----------------
                        TOTAL_FP

                     token_in x 50
                 = -----------------
                         100000_

### POOL_ID

```solidity
bytes32 POOL_ID
```

### POOL_TYPE

```solidity
enum ICronV1PoolEnums.PoolType POOL_TYPE
```

### slot1

```solidity
uint256 slot1
```

### slot2

```solidity
uint256 slot2
```

### slot3

```solidity
uint256 slot3
```

### slot4

```solidity
uint256 slot4
```

### priceOracle

```solidity
struct PriceOracle priceOracle
```

### adminAddrMap

```solidity
mapping(address => bool) adminAddrMap
```

### partnerContractAddrMap

```solidity
mapping(address => address) partnerContractAddrMap
```

### feeAddr

```solidity
address feeAddr
```

### senderIsFactoryOwner

```solidity
modifier senderIsFactoryOwner()
```

Ensure that the modified function is called by an address that is the factory owner.

_Cannot be used on Balancer Vault callbacks (onJoin, onExit,
        onSwap) because msg.sender is the Vault address._

### senderIsAdmin

```solidity
modifier senderIsAdmin()
```

Ensures that the modified function is called by an address with administrator privileges.

_Cannot be used on Balancer Vault callbacks (onJoin, onExit,
        onSwap) because msg.sender is the Vault address._

### senderIsArbitragePartner

```solidity
modifier senderIsArbitragePartner()
```

Ensures the modified function is called by an address with arbitrage partner privileges.

_Cannot be used on Balancer Vault callbacks (onJoin, onExit,
        onSwap) because msg.sender is the Vault address._

### poolNotPaused

```solidity
modifier poolNotPaused()
```

Ensures that the modified function is not executed if the pool is currently paused.

### constructor

```solidity
constructor(contract IERC20 _token0Inst, contract IERC20 _token1Inst, contract IVault _vaultInst, string _poolName, string _poolSymbol, enum ICronV1PoolEnums.PoolType _poolType) public
```

Creates an instance of the Cron-Fi TWAMM pool. A Cron-Fi TWAMM pool features virtual order management and
        virtualized reserves. Liquidity is managed through an instance of BalancerPoolToken.
        The fees associated with the pool are configurable at run-time.

        Importantly, the OBI cannot be changed after instantiation. If a pool's OBI is inappropriate to the
        properties of the pair of tokens, it is recommended to create a new pool.

        In the event of a failure, the pool can be paused which bypasses computation of virtual orders and allows
        liquidity to be removed and long-term virtual orders to be withdrawn and refunded. Other operations are
        blocked.

        Management of the pool is performed by administrators who are able set gross swap fee amounts and
        aribtrage partner status.

        The pool factory owner is able to set the status of administrators, enable Cron-Fi fees, modify the
        Cron-Fi fee address, adjust the fee-split between Cron-Fi and liquidity providers, and enable Balancer
        fees.

        Arbitrage partners are able to set and update a contract address that lists their arbitrageur's addresses,
        which are able to swap at reduced fees as an incentive to provide better long-term order execution by
        adjusting the bonding curve to compensate for the effect of virtual orders. These partners perform
        accounting and capture a percentage of the trades or capture fees in another way which are periodically
        remitted to the pool, rewarding the liquidity providers. This may be thought of as a constructive pay for
        order flow or Maximal Extractable Value (MEV) recapture.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _token0Inst | contract IERC20 | The contract instance for token 0. |
| _token1Inst | contract IERC20 | The contract instance for token 1. |
| _vaultInst | contract IVault | The Balancer Vault instance this pool be a member of. |
| _poolName | string | The name for this pool. |
| _poolSymbol | string | The symbol for this pool. |
| _poolType | enum ICronV1PoolEnums.PoolType | A value in the enumeration PoolType that controls the initial fee values and Order Block                  Interval (OBI) of the pool. See the documentation for the PoolType enumeration for details. |

### onSwap

```solidity
function onSwap(struct IPoolSwapStructs.SwapRequest _swapRequest, uint256 _currentBalanceTokenInU112, uint256 _currentBalanceTokenOutU112) external returns (uint256 amountOutU112)
```

Called by the vault when a user calls IVault.swap. Can be used to perform a Short-Term (ST)
        swap, Long-Term (LT) swap, or Partner swap
        ST swaps and Partner swaps behave like traditional Automated Market Maker atomic swaps
        (think Uniswap V2 swaps).
        LT swaps are virtual orders and behave differently, executing over successive blocks until
        their expiry. Each LT swap is assigned an order id that is logged in a LongTermSwap event and
        can also be fetched using getOrderIds for a given address. LT swaps can be withdrawn or
        cancelled through the IVault.exit function (see onExitPool documentation).

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _swapRequest | struct IPoolSwapStructs.SwapRequest | Is documented in Balancer's IPoolSwapStructs.sol. However, the userData field                     of this _swapRequest struct is a uint256 value, swapTypeU, followed by another                     uint256 value, argument, detailed below:                       * swapTypeU is decoded into the enum SwapType and determines if the transaction                         is a RegularSwap, LongTermSwap, or PartnerSwap.                         Min. = 0, Max. = 3                       * argument is a value, the use of which depends upon the SwapType value passed                                  into swapTypeU:                           - swapTypeU=0 (RegularSwap):  argument is ignored / not used.                           - swapTypeU=1 (LongTermSwap): argument is the number of order intervals for                                                         the LT trade before expiry.                           - swapTypeU=2 (PartnerSwap):  argument is the Partner address stored in a                                                         uint256. It is used to loop up the Partner's                                                         current arbitrage list contract address.                     Delegates:                     If the specified swapType is a LongTermSwap, the _swapRequest.to field can be                     used to specify a LT-Swap delegate. The delegate account is able to withdraw or                     cancel the LT-swap on behalf of the order owner (_swapRequest.from) at any time,                     so long as the recipient account specified for proceeds or refunds is the order                     owner. (The order owner does not have this restriction and direct proceeds or                     refunds to any desired account.)                     If the specified _swapRequest.to field is the null address or the order owner,                     then the delegate is disabled (and set to the null address). |
| _currentBalanceTokenInU112 | uint256 | The Balancer Vault balance of the token being sold to the pool.                                   Min. = 0, Max. = (2**112) - 1 |
| _currentBalanceTokenOutU112 | uint256 | The Balancer Vault balance of the token being bought from the pool.                                    Min. = 0, Max. = (2**112) - 1 |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| amountOutU112 | uint256 | The amount of token being bought from the pool in this swap. For LT swaps this                       will always be zero. Proceeds from an LT swap can be withdrawn or the order                       refunded with an appropriate call to the IVault.exit function (see onExitPool                       documentation). |

### onJoinPool

```solidity
function onJoinPool(bytes32 _poolId, address _sender, address _recipient, uint256[] _currentBalancesU112, uint256, uint256 _protocolFeeDU1F18, bytes _userData) external returns (uint256[] amountsInU112, uint256[] dueProtocolFeeAmountsU96)
```

Called by the Vault when a user calls IVault.joinPool. Can be use to add liquidity to
        the pool in exchange for Liquidity Provider (LP) pool tokens or to reward the pool with
        liquidity (MEV rewards from arbitrageurs).
        WARNING: The initial liquidity provider, in a call to join the pool with joinTypeU=0
                 (JoinType.Join), will sacrifice MINIMUM_LIQUIDITY, 1000, Liquidity Provider (LP)
                 tokens. This may be an insignificant sacrifice for tokens with fewer decimal
                 places and high worth (i.e. WBTC).
        Importantly, the reward capability remains when the pool is paused to mitigate any
        possible issue with underflowed pool reserves computed by differencing the pool accounting
        from the pool token balances.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _poolId | bytes32 | The ID for this pool in the Balancer Vault |
| _sender | address | is the account performing the Join or Reward transaction (typically an LP or MEV reward                contract, respectively). |
| _recipient | address | is the account designated to receive pool shares in the form of LP tokens when                   Joining the pool. Can be set to _sender if sender wishes to receive the tokens                   and Join Events. |
| _currentBalancesU112 | uint256[] | an array containing the Balancer Vault balances of Token 0 and Token 1                             in this pool. The balances are in the same order that IVault.getPoolTokens                             returns.                             Min. = 0, Max. = (2**112) - 1 |
|  | uint256 |  |
| _protocolFeeDU1F18 | uint256 | the Balancer protocol fee.                           Min. = 0, Max. = 10**18 |
| _userData | bytes | is uint256 value, joinTypeU, followed by an array of 2 uint256 values, amounts,                  and another array of 2 uint256 values, minAmounts, detailed below:                    * joinTypeU is decoded into the enum JoinType and determines if the transaction is                                a Join or Reward.                                Min. = 0, Max. = 1                    * amountsInU112 are the amount of Token 0 and Token 1 to Join or Reward the pool                                    with, passed in the same array ordering that IVault.getPoolTokens                                    returns.                                    Min. = 0, Max. = (2**112) - 1                    * minAmountsU112 are the minimum amount of Token 0 and Token 1 prices at which                                     to Join the pool (protecting against sandwich attacks), passed                                     in the same array ordering that IVault.getPoolTokens returns.                                     The minAmountsU112 values are ignored unless joinTypeU is                                     0 (JoinType.Join). In the initial join, these values are                                     ignored.                                     Min. = 0, Max. = (2**112) - 1 |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| amountsInU112 | uint256[] | is the amount of Token 0 and Token 1 provided to the pool as part of a Join or                       Reward transaction. Values are returned in the same array ordering that                       IVault.getPoolTokens returns.                       Min. = 0, Max. = (2**112) - 1 |
| dueProtocolFeeAmountsU96 | uint256[] | the amount of Token 0 and Token 1 collected by the pool for                                  Balancer. Values are returned in the same array ordering that                                  IVault.getPoolTokens returns.                                  Min. = 0, Max. = (2**96) - 1 |

### onExitPool

```solidity
function onExitPool(bytes32 _poolId, address _sender, address _recipient, uint256[] _currentBalancesU112, uint256, uint256 _protocolFeeDU1F18, bytes _userData) external returns (uint256[] amountsOutU112, uint256[] dueProtocolFeeAmountsU96)
```

Called by the Vault when a user calls IVault.exitPool. Can be used to remove liquidity from
        the pool in exchange for Liquidity Provider (LP) pool tokens, to withdraw proceeds of a
        Long-Term (LT) order, to cancel an LT order, or by the factory owner to withdraw protocol
        fees if they are being collected.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _poolId | bytes32 | is the ID for this pool in the Balancer Vault |
| _sender | address | is the account performing the liquidity removal, LT order withdrawl, LT order                cancellation or the factory owner withdrawing fees.                For long term orders, a "delegate" may be specified, this address is able to                perform LT order withdraws and cancellations on behalf of the LT swap owner as                long as the recipient is the LT swap owner. |
| _recipient | address | For LT swaps the recipient must always be the original order owner (the address                   that issued the order) if a "delegate" address is performing the withdrawl or                   cancellation. If the order owner is performing the withdrawl or cancellation, the                   recipient can be set to whatever destination address desired.                   For other exit types (Exit & FeeWithdraw), the recipient can be set as desired                   so long as the sender is set to the authorized address. |
| _currentBalancesU112 | uint256[] | is an array containing the Balancer Vault balances of Token 0 and Token 1                             in this pool. The balances are in the same order that IVault.getPoolTokens                             returns.                             Min. = 0, Max. = (2**112) - 1 |
|  | uint256 |  |
| _protocolFeeDU1F18 | uint256 | is the Balancer protocol fee.                           Min. = 0, Max. = 10**18 |
| _userData | bytes | is uint256 value, exitTypeU, followed by a uint256, argument, detailed below:                    * exitTypeU is decoded into the enum ExitType and determines if the transaction is                                an Exit, Withdraw, Cancel, or FeeWithdraw.                                Min. = 0, Max. = 3                    * argument is used differently based on the ExitType value passed into exitTypeU:                                 - exitTypeU=0 (Exit):        argument is the number of LP tokens to                                                              redeem on Exit.                                 - exitTypeU=1 (Withdraw):    argument is the LT Swap order ID.                                 - exitTypeU=2 (Cancel):      argument is the LT Swap order ID.                                 - exitTypeU=3 (FeeWithdraw): argument is ignored / not used. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| amountsOutU112 | uint256[] | is the amount of Token 0 and Token 1 provided by the pool as part of an Exit,                        LT Swap Withdrawl, LT Swap Cancel, or Fee Withdraw transaction. Values are                        returned in the same array ordering that IVault.getPoolTokens returns.                        Min. = 0, Max. = (2**112) - 1 |
| dueProtocolFeeAmountsU96 | uint256[] | the amount of Token 0 and Token 1 collected by the pool for                                  Balancer. Values are returned in the same array ordering that                                  IVault.getPoolTokens returns.                                  Min. = 0, Max. = (2**96) - 1 |

### setAdminStatus

```solidity
function setAdminStatus(address _admin, bool _status) external
```

Set the administrator status of the provided address, _admin. Status "true" gives
        administrative privileges, "false" removes privileges.

_CAREFUL! You can remove all administrative privileges, rendering the contract unmanageable.
NOTE: Must be called by the factory owner._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _admin | address | The address to add or remove administrative privileges from. |
| _status | bool | Whether to grant (true) or deny (false) administrative privileges. |

### setFeeAddress

```solidity
function setFeeAddress(address _feeDestination) external
```

Enables Cron-Fi fee collection for Long-Term swaps when the provided address,
        _feeDestination is not the null address.

_CAREFUL! Only the _feeDestination address can collect Cron-Fi fees from the pool.
NOTE: Must be called by the factory owner._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _feeDestination | address | The address that can collect Cron-Fi Swap fees. If set to the null address,                        no Cron-Fi Long-Term swap fees are collected. |

### setPause

```solidity
function setPause(bool _pauseValue) external
```

Sets whether the pool is paused or not. When the pool is paused:
            * New swaps of any kind cannot be issued.
            * Liquidity cannot be provided.
            * Virtual orders are not executed for the remainder of allowable
              operations, which include: removing liquidity, cancelling or
              withdrawing a Long-Term swap order,
        This is a safety measure that is not a part of expected pool operations.

_NOTE: Must be called by an administrator._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _pauseValue | bool | Pause the pool (true) or not (false). |

### setParameter

```solidity
function setParameter(uint256 _paramTypeU, uint256 _value) external
```

Set fee parameters.

_NOTE: Total FP = 100,000. Thus a fee portion is the number of FP out of 100,000.
NOTE: Must be called by an administrator._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _paramTypeU | uint256 | A numerical value corresponding to the enum ParamType (see documentation                    for that above or values and corresponding ranges below). |
| _value | uint256 | A value to set the specified parameter given in _paramTypeU. The values and               their ranges are as follows:     Short-Term Swap Fee Points:         * _paramTypeU = 0  (ParamType.SwapFeeFP)         * 0 <= _value <= C.MAX_FEE_FP (1000, ~1.000%)     Partner Swap Fee Points:         * _paramTypeU = 1  (ParamType.PartnerFeeFP)         * 0 <= _value <= C.MAX_FEE_FP (1000, ~1.000%)     Long-Term Swap Fee Points:         * _paramTypeU = 2  (ParamType.LongSwapFeeFP)         * 0 <= _value <= C.MAX_FEE_FP (1000, ~1.000%) |

### setCollectBalancerFees

```solidity
function setCollectBalancerFees(bool _collectBalancerFee) external
```

Enable or disable the collection of Balancer Fees. When enabled Balancer takes a
        a portion of every fee collected in the pool. The pool remits fees to Balancer
        automatically when onJoinPool and onExitPool are called. Disabling balancer fees
        through this function supersedes any setting of balancer fee values in onJoinPool
        and onExitPool.

_NOTE: Must be called by the factory owner._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _collectBalancerFee | bool | When true, Balancer fees are collected, when false they are                            not collected. |

### setFeeShift

```solidity
function setFeeShift(uint256 _feeShift) external
```

Sets the fee shift that splits Long-Term (LT) swap fees remaining after Balancer's cut
        between the Liquidity Providers (LP) and Cron-Fi, if Cron-Fi fee collection is enabled.

_NOTE: Must be called by the factory owner._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _feeShift | uint256 | A value between 1 and 4. Specifiying invalid values results in no-operation                  (percentages are approximate). The implication of these values are outlined                  below and are only applicable if Cron-Fi fees are being collected:                      _feeShift = 1:                          LP gets 2 fee shares (~66%), Cron-Fi gets 1 fee share (~33%)                      _feeShift = 2:                          LP gets 4 fee shares (~80%), Cron-Fi gets 1 fee share (~20%)                      _feeShift = 3:                          LP gets 8 fee shares (~88%), Cron-Fi gets 1 fee share (~12%)                      _feeShift = 4:                          LP gets 16 fee shares (~94%), Cron-Fi gets 1 fee share (~6%) |

### setArbitragePartner

```solidity
function setArbitragePartner(address _arbPartner, address _arbitrageList) external
```

Sets the arbitrageur list contract address, _arbitrageList, for an arbitrage
        partner, _arbPartner. To clear an arbitrage partner, set _arbitrageList to the
        null address.

_NOTE: Must be called by an administrator._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _arbPartner | address | The address of the arbitrage partner. This should be the aribtrage                    partner's public address and shareable with members of the the                    arbitrage list contract. |
| _arbitrageList | address | The address of a deployed arbitrageur list contract for the                       specified arbitrage partner. The deployed contract should                       conform to the interface IArbitrageurList. |

### updateArbitrageList

```solidity
function updateArbitrageList() external returns (address)
```

Advances the specified arbitrage partner (msg.sender) arbitrageur list
        contract to the newest contract, if available. See IArbitrageurList for
        details on the calls made by this contract to that interface's nextList
        function.

_NOTE: Must be called by an arbitrage partner._

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| [0] | address | the new arbitrageur list contract address. |

### executeVirtualOrdersToBlock

```solidity
function executeVirtualOrdersToBlock(uint256 _maxBlock) external
```

Executes active virtual orders, Long-Term swaps, since the last virtual order block
        executed,  updating reserve and other state variables to the current block.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _maxBlock | uint256 | A block to update the virtual orders to. In most situations this would be                  the current block, however if the pool has been inactive for a considerable                  duration, specifying an earlier block allows gas use to be reduced in the event                  that the gas needed to update to the current block for a transaction to be                  performed exceeds the nominal or extended amounts available to an Ethereum                  transaction (15M & 30M respectively at the time of this writing).                  If the specified max block preceeds the last virtual order block then the                  current block number is automatically used. |

### getVirtualPriceOracle

```solidity
function getVirtualPriceOracle(uint256 _maxBlock) external returns (uint256 timestamp, uint256 token0U256F112, uint256 token1U256F112, uint256 blockNumber)
```

Get the virtual price oracle data for the pool at the specified block, _maxBlock.

        IMPORTANT - This function calls _getVirtualReserves, which triggers a re-entrancy check. Due
                    to contract size challanges, there is no explicit call to that re-entrancy check
                    in this function, where it's presence would be more obvious.

        IMPORTANT - This function does not meaningfully modify state despite the lack of a "view"
                    designator for state mutability. (The call to _triggerVaultReentrancyCheck
                    Unfortunately prevents the "view" designator as meaningless value is written
                    to state to trigger a reentracy check).

        Runs virtual orders from the last virtual order block up to the current block to provide
        visibility into the current accounting for the pool.
        If the pool is paused, this function reflects the accounting values of the pool at
        the last virtual order block (i.e. it does not execute virtual orders to deliver the result).

_Check that blockNumber matches _maxBlock to ensure that _maxBlock was correctly
     specified._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _maxBlock | uint256 | is the block to determine the virtual oracle values at. Its value must be                  greater than the last virtual order block and less than or equal to the                  current block. Otherwise, current block is used in the computation and                  reflected in the return value, blockNumber. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| timestamp | uint256 | is the virtual timestamp in seconds corresponding to the price oracle                   values. |
| token0U256F112 | uint256 | The virtual cumulative price of Token0 measured in amount of                        Token1 * seconds at timestamp. |
| token1U256F112 | uint256 | The virtual cumulative price of Token1 measured in amount of                        Token0 * seconds at timestamp. |
| blockNumber | uint256 | The block that the virtual oracle values were computed at. Should                     match parameter _maxBlock, unless _maxBlock was not greater than the                     last virtual order block or less than or equal to the current block. |

### getVirtualReserves

```solidity
function getVirtualReserves(uint256 _maxBlock, bool _paused) external returns (uint256 blockNumber, uint256 token0ReserveU112, uint256 token1ReserveU112, uint256 token0OrdersU112, uint256 token1OrdersU112, uint256 token0ProceedsU112, uint256 token1ProceedsU112, uint256 token0BalancerFeesU96, uint256 token1BalancerFeesU96, uint256 token0CronFiFeesU96, uint256 token1CronFiFeesU96)
```

Returns the TWAMM pool's reserves after the non-stateful execution of all virtual orders
        up to the specified maximum block (unless an invalid block is specified, which results
        in execution to the current block).

        IMPORTANT - This function calls _getVirtualReserves, which triggers a re-entrancy check. Due
                    to contract size challanges, there is no explicit call to that re-entrancy check
                    in this function, where it's presence would be more obvious.

        IMPORTANT - This function does not meaningfully modify state despite the lack of a "view"
                    designator for state mutability. (The call to _triggerVaultReentrancyCheck
                    Unfortunately prevents the "view" designator as meaningless value is written
                    to state to trigger a reentracy check).

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _maxBlock | uint256 | a block to update virtual orders to. If less than or equal to the last virtual order                  block or greater than the current block, the value is set to the current                  block number. |
| _paused | bool | is true to indicate the result should be returned as though the pool is in a paused                state where virtual orders are not executed and only withdraw, cancel and liquidations                are possible (check function isPaused to see if the pool is in that state). If false                then the virtual reserves are computed from virtual order execution to the specified                block. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| blockNumber | uint256 | The block that the virtual reserve values were computed at. Should                     match parameter _maxBlock, unless _maxBlock was not greater than the                     last virtual order block or less than or equal to the current block. |
| token0ReserveU112 | uint256 | virtual reserves of Token0 in the TWAMM pool at blockNumber. |
| token1ReserveU112 | uint256 | virtual reserves of Token1 in the TWAMM pool at blockNumber. |
| token0OrdersU112 | uint256 | virtual amount of Token0 remaining to be sold to the pool in LT swap orders                          at blockNumber. |
| token1OrdersU112 | uint256 | virtual amount of Token1 remaining to be sold to the pool in LT swap orders                          at blockNumber. |
| token0ProceedsU112 | uint256 | virtual amount of Token0 purchased from the pool by LT swap orders                            at blockNumber. |
| token1ProceedsU112 | uint256 | virtual amount of Token1 purchased from the pool by LT swap orders                            at blockNumber. |
| token0BalancerFeesU96 | uint256 | virtual Balancer fees collected for all types of Token0-->Token1 swaps                               at blockNumber. |
| token1BalancerFeesU96 | uint256 | virtual Balancer fees collected for all types of Token1-->Token0 swaps                               at blockNumber. |
| token0CronFiFeesU96 | uint256 | virtual Cron-Fi fees collected for Token0-->Token1 Long-Term swaps at                             blockNumber. |
| token1CronFiFeesU96 | uint256 | virtual Cron-Fi fees collected for Token1-->Token0 Long-Term swaps at                             blockNumber. |

### getPriceOracle

```solidity
function getPriceOracle() external view returns (uint256 timestamp, uint256 token0U256F112, uint256 token1U256F112)
```

Get the price oracle data for the pool as of the last virtual order block.

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| timestamp | uint256 | is the timestamp in seconds when the price oracle was last updated. |
| token0U256F112 | uint256 | The cumulative price of Token0 measured in amount of                        Token1 * seconds. |
| token1U256F112 | uint256 | The cumulative price of Token1 measured in amount of                        Token0 * seconds. |

### getOrderIds

```solidity
function getOrderIds(address _owner, uint256 _offset, uint256 _maxResults) external view returns (uint256[] orderIds, uint256 numResults, uint256 totalResults)
```

Return an array of the order IDs for the specified user _owner. Allows all orders to be fetched
        at once or pagination through the _offset and _maxResults parameters. For instance to get the
        first 100 orderIds of a user, specify _offset=0 and _maxResults=100. To get the second 100
        orderIds for the same user, specify _offset=100 and _maxResults=100. To get all results at once,
        either specify all known results or 0 for _maxResults.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _owner | address | is the address of the owner to fetch order ids for. |
| _offset | uint256 | is the number of elements from the end of the list to start fetching results from (                 consult the operating description above). |
| _maxResults | uint256 | is the maximum number of results to return when calling this function (i.e. if                     this is set to 1,000 and there are 10,000 results available, only 1,000 from the                     specified offset will be returned). If 0 is specified, then all results available are                     returned. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| orderIds | uint256[] | A uint256 array of order IDs associated with user's address. |
| numResults | uint256 | The number of order IDs returned (if a user has less than the specified maximum                    number of results, indices in the returned order ids array after numResults-1 will                    be zero). |
| totalResults | uint256 | The total number of order IDs associated with this user's address.                      (Useful for pagination of results--i.e. increase _offset by 100 until                       totalResults - 100 is reached). |

### getOrder

```solidity
function getOrder(uint256 _orderId) external view returns (struct Order order)
```

Return the order information of a given order id.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _orderId | uint256 | is the id of the order to return. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| order | struct Order | is the order data corresponding to the given order id. See Order struct documentation               for additional information. |

### getOrderIdCount

```solidity
function getOrderIdCount() external view returns (uint256 nextOrderId)
```

Returns the number of virtual orders, Long-Term (LT) swaps, that have been transacted in
        this pool.

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| nextOrderId | uint256 | The number of virtual orders issued (also the next order ID that is                     assigned to a LT swap.) |

### getSalesRates

```solidity
function getSalesRates() external view returns (uint256 salesRate0U112, uint256 salesRate1U112)
```

Returns the sales rate of each of the two order pools at the last virtual order block.
        This is the value persisted to state.

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| salesRate0U112 | uint256 | order pool 0 sales rate. The amount of Token 0 sold to the pool, per block,                        in exchange for Token 1, on behalf of all active Long-Term (LT) swap orders,                        swapping Token0 for Token1, as of the last virtual order block.                        Min. = 0, Max. = (2**112) - 1 |
| salesRate1U112 | uint256 | order pool 1 sales rate. The amount of Token 1 sold to the pool, per block,                        in exchange for Token 0, on behalf of all active Long-Term (LT) swap orders,                        swapping Token1 for Token0, as of the last virtual order block.                        Min. = 0, Max. = (2**112) - 1 |

### getLastVirtualOrderBlock

```solidity
function getLastVirtualOrderBlock() external view returns (uint256 lastVirtualOrderBlock)
```

Get the Last Virtual Order Block (LVOB) for the pool. This is the block number indicating the last block
        where virtual orders have been executed by the pool. If the LVOB is significantly less than the current
        block number, it indicates that the pool has been inactive and that a call to any function that requires
        the execution of virtual orders may incur siginificant gas use.

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| lastVirtualOrderBlock | uint256 | is the last block number that virtual orders have been executed to. |

### getSalesRatesEndingPerBlock

```solidity
function getSalesRatesEndingPerBlock(uint256 _blockNumber) external view returns (uint256 salesRateEndingPerBlock0U112, uint256 salesRateEndingPerBlock1U112)
```

Get the sales rate ending (per block) at the specified block number.

_NOTE: these values are inserted into state at block numbers divisible by the Order Block
           Interval (OBI)--specifiying block numbers other than those evenly divisible by the
           OBI will result in the returned values being zero._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _blockNumber | uint256 |  |

### getShortTermFeePoints

```solidity
function getShortTermFeePoints() external view returns (uint256)
```

Gets the current Short-Term (ST) swap fee for the pool in Fee Points.

_NOTE: Total FP = 100,000. Thus a fee portion is the number of FP out
           of 100,000._

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| [0] | uint256 | The ST swap Fee Points (FP).         Min. = 0, Max. = 1000 (C.MAX_FEE_FP) |

### getPartnerFeePoints

```solidity
function getPartnerFeePoints() external view returns (uint256)
```

Gets the current Partner swap fee for the pool in Fee Points.

_NOTE: Total FP = 100,000. Thus a fee portion is the number of FP out
           of 100,000._

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| [0] | uint256 | The Partner swap Fee Points (FP).         Min. = 0, Max. = 1000 (C.MAX_FEE_FP) |

### getLongTermFeePoints

```solidity
function getLongTermFeePoints() external view returns (uint256)
```

Gets the current Long-Term (LT) swap fee for the pool in Fee Points.

_NOTE: Total FP = 100,000. Thus a fee portion is the number of FP out
           of 100,000._

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| [0] | uint256 | The LT swap Fee Points (FP).         Min. = 0, Max. = 1000 (C.MAX_FEE_FP) |

### getOrderAmounts

```solidity
function getOrderAmounts() external view returns (uint256 orders0U112, uint256 orders1U112)
```

Gets the amounts of Token0 and Token1 in active virtual orders waiting to
        be sold to the pool as of the last virtual order block.

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| orders0U112 | uint256 | is the aggregated amount of Token0 for active swaps from Token0 to Token1,         waiting to be sold to the pool since the last virtual order block.         Min. = 0, Max. = (2**112)-1 |
| orders1U112 | uint256 | is the aggregated amount of Token1 for active swaps from Token1 to Token0,         waiting to be sold to the pool since the last virtual order block.         Min. = 0, Max. = (2**112)-1 |

### getProceedAmounts

```solidity
function getProceedAmounts() external view returns (uint256 proceeds0U112, uint256 proceeds1U112)
```

Get the proceeds of Token0 and Token1 resulting from
        virtual orders, Long-Term swaps, up to the last virtual order block.

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| proceeds0U112 | uint256 | is the aggregated amount of Token0 from swaps selling Token1 for Token0                       to the pool, waiting to be withdrawn, as of the last virtual order block.                       Min. = 0, Max. = (2**112)-1 |
| proceeds1U112 | uint256 | is the aggregated amount of Token1 from swaps selling Token1 for Token0                       to the pool, waiting to be withdrawn, as of the last virtual order block.                       Min. = 0, Max. = (2**112)-1 |

### getFeeShift

```solidity
function getFeeShift() external view returns (uint256)
```

Gets the current value of the fee shift, which indicates how Long-Term (LT) swap fees are
        split between Cron-Fi and Liquidity Providers (LPs) when Cron-Fi fee collection is enabled.

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| [0] | uint256 | A value between 1 and 4 that is the fee shift used to determine fee spliting between Cron-Fi         and LPs:               Fee Shift = 1:                   LP gets 2 fee shares (~66%), Cron-Fi gets 1 fee share (~33%)               Fee Shift = 2:                   LP gets 4 fee shares (~80%), Cron-Fi gets 1 fee share (~20%)               Fee Shift = 3:                   LP gets 8 fee shares (~88%), Cron-Fi gets 1 fee share (~12%)               Fee Shift = 4:                   LP gets 16 fee shares (~94%), Cron-Fi gets 1 fee share (~6%) |

### getCronFeeAmounts

```solidity
function getCronFeeAmounts() external view returns (uint256 cronFee0U96, uint256 cronFee1U96)
```

Gets the amounts of Token0 and Token1 collected as Cron-Fi fees on Long-Term (LT) swaps
        as of the last virtual order block.

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| cronFee0U96 | uint256 | the amount of Token0 Cron-Fi fees collected as of the last virtual order block.                      Min. = 0, Max. = (2**96) - 1 |
| cronFee1U96 | uint256 | the amount of Token1 Cron-Fi fees collected as of the last virtual order block.                      Min. = 0, Max. = (2**96) - 1 |

### isCollectingCronFees

```solidity
function isCollectingCronFees() external view returns (bool)
```

Use to determine if the pool is collecting Cron-Fi fees currently (Cron-Fi fees are only
        collected on Long-Term swaps if enabled).

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| [0] | bool | True if the pool is collecting Cron-Fi fees, false otherwise. |

### isCollectingBalancerFees

```solidity
function isCollectingBalancerFees() external view returns (bool)
```

Use to determine if the pool is collecting Balancer fees currently (Balancer fees apply to
        any fee collected by the pool--Short and Long Term swaps).

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| [0] | bool | True if the pool is collecting Balancer fees, false otherwise. |

### getBalancerFee

```solidity
function getBalancerFee() external view returns (uint256)
```

Get the Balancer Fee charged by the pool.

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| [0] | uint256 | The current Balancer Fee, a number that is divided by 1e18 (C.ONE_DU1_18) to arrive at a         fee multiplier between 0 and 1 with 18 fractional decimal digits.         Min. = 0.000000000000000000, Max. = 1.000000000000000000 |

### getBalancerFeeAmounts

```solidity
function getBalancerFeeAmounts() external view returns (uint256 balFee0U96, uint256 balFee1U96)
```

Gets the amounts of Token0 and Token1 collected as Balancer fees on all swaps as of the last
        virtual order block.

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| balFee0U96 | uint256 | the amount of Token0 Balancer fees collected as of the last virtual order block.                      Min. = 0, Max. = (2**96) - 1 |
| balFee1U96 | uint256 | the amount of Token1 Balancer fees collected as of the last virtual order block.                      Min. = 0, Max. = (2**96) - 1 |

### isPaused

```solidity
function isPaused() public view returns (bool)
```

Use to determine if the pool's virtual orders are currently paused. If virtual orders are
        paused, the pool will allow Long-Term (LT) swaps to be cancelled and withdrawn from as well
        as liquidity positions to be withdrawn.

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| [0] | bool | True if the pool is paused, false otherwise. |

### _senderIsFactoryOwner

```solidity
function _senderIsFactoryOwner() internal view
```

Reverts with error if msg.sender is not the factory owner.

_This internal function is a modifier contract size optimization._

### _senderIsAdmin

```solidity
function _senderIsAdmin() internal view
```

Reverts with error if msg.sender is not a pool administrator.

_This internal function is a modifier contract size optimization._

### _senderIsArbitragePartner

```solidity
function _senderIsArbitragePartner() internal view
```

Reverts with error if msg.sender is not an arbitrage partner.

_This internal function is a modifier contract size optimization._

### _poolNotPaused

```solidity
function _poolNotPaused() internal view
```

Reverts with error if the pool is paused.

_This internal function is a modifier contract size optimization._

### _calculateProceeds

```solidity
function _calculateProceeds(uint256 _scaledProceedsU128, uint256 _startScaledProceedsU128, uint256 _salesRateU112, bool _token0To1) internal view returns (uint256 proceedsU112)
```

Computes the proceeds of a virtual order, Long-Term (LT) swap, for withdrawl or
        cancellation purposes. Proceeds are determined using the staking algorithm, where
        the user's order sales rate, _stakedAmountU128, represents their stake and the
        difference between the normalized proceeds at this juncture or their order end and
        order start are used to calculate their share. The normalized proceeds are
        stored in 128-bits with 64 fractional-bits, hence the scaling down by 64-bits below.

_Note explanations for required underflow in this calculation below._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _scaledProceedsU128 | uint256 | The current or order end normalized scaled proceeds value. |
| _startScaledProceedsU128 | uint256 | The normalized scaled proceeds value at the start of the                                 order (or when it was last withdrawn from). |
| _salesRateU112 | uint256 | The order's sales rate in token per block. |
| _token0To1 | bool | the direction of this swap, true if selling Token 0 for Token1, false otherwise. |

