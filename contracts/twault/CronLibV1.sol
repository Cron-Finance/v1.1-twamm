// SPDX-License-Identifier: BUSL-1.1

// (c) Copyright 2024, Bad Pumpkin Inc. All Rights Reserved
//
pragma solidity ^0.7.6;

import { Math } from "./balancer-core-v2/lib/math/Math.sol";

import { C } from "./miscellany/Constants.sol";
import { requireErrCode, CronErrors } from "./miscellany/Errors.sol";
import { sqrt } from "./miscellany/Misc.sol";
import { BitPackingLib } from "./miscellany/BitPacking.sol";
import { Order, OrderPools, VirtualOrders } from "./interfaces/Structs.sol";

library CronLibV1 {
  using Math for uint256;

  /// @notice ProtocolFeeTooLarge is emitted if the protocol fee passed in by balancer ever exceeds
  ///         1e18 (in which case the change is ignored and fees continue with the last good value).
  ///
  event ProtocolFeeTooLarge(uint256 suggestedProtocolFee);

  /// @notice Execute a Long-Term swap (LT) Virtual Order, which sells an amount of one of the pool
  ///         tokens to the pool over a number of blocks, as described in the parameters below.
  ///         An LT swap can be withdrawn one or more times until the order has expired and all proceeds
  ///         have been withdrawn.
  ///         An LT swap can be cancelled anytime before expiry for a refund of unsold tokens and any
  ///         proceeds obtained before cancellation.
  ///         To withdraw or cancel, call the IVault.exit function (see documentaion for onExitPool).
  ///         WARNING: Any amount specified that does not divide evenly into the amount of blocks for
  ///         the virtual order will end up in pool reserves, yielding the user nothing for their capital.
  ///         For instance a trade of 224 Token-0 over two intervals (OBI=75) starting at block 75 would
  ///         result in a sales rate of 2 Token-0 per block for 150 blocks, 2 Order Block Intervals (OBI),
  ///         and the remaining 74 Token-0 would end up in the pool reserves yielding no benefit to the user.
  /// @param _sender is the account issuing the LT swap transaction. Only this account can withdraw the
  ///                order.
  /// @param _delegate is an account that is able to withdraw or cancel the LT swap on behalf of the
  ///                  sender account, as long as the recipient specified is the sender account.
  ///                  If the delegate is set to the sender account, then the delegate is set
  ///                  to the null address.
  /// @param _token0To1 is the direction of this swap, true if selling Token 0 for Token1, false otherwise.
  /// @param _amountInU112 is the amount of token being sold to the pool in this swap.
  ///                      Min. = 0, Max. = (2**112) - 1
  /// @param _orderIntervals is the number of intervals to execute the LT swap before expiring. An interval
  ///                        can be 75 blocks (Stable Pool), 300 blocks (Liquid Pool), 1200 blocks (Volatile
  ///                        Pool), or 7200 blocks (Daily Pool).
  ///                        Min. = 0, Max. = STABLE_MAX_INTERVALS,
  ///                                         LIQUID_MAX_INTERVALS,
  ///                                         VOLATILE_MAX_INTERVALS,
  ///                                         DAILY_MAX_INTERVALS (depending on POOL_TYPE).
  /// @param _orderBlockInterval is the number of blocks in an Order Block Interval (OBI), and is expected
  ///                            to be one of the following values:
  ///                                STABLE_OBI      (75 blocks)
  ///                                LIQUID_OBI     (300 blocks)
  ///                                VOLATILE_OBI  (1200 blocks)
  ///                                DAILY_OBI     (7200 blocks)
  /// @return orderAmount is the actual amount of token being sold to the pool in this swap. Actual in
  ///                     this case means it's the product of the order sales rate and the number of order
  ///                     blocks, which may be less than _amountInU112, as discussed in the warning for
  ///                     this function.
  ///                     Min. = 0, Max. = (2**112) - 1
  /// @return orderId is the order identifier for the LT swap virtual order created. Users can see what
  ///                 order identifiers they've created by callin getOrderIds.
  /// @dev The order id for an issued order is in the event log emitted by this function. No safety is provided
  ///      for checking existing order ids being reissued because the order id space is very large: (2**256) - 1.
  ///
  /// #RISK: An order-wrap attack (where a user trys to issue so many orders that the order ID counter
  ///        overflows, giving them access to order proceeds) is unlikely since the minimum measured gas
  ///        cost of a call to onSwap resulting in a call to _longTermSwap is ~220k gas (not including
  ///        approvals and transfers).
  ///
  function longTermSwap(
    VirtualOrders storage _virtualOrders,
    address _sender,
    address _delegate,
    bool _token0To1,
    uint256 _amountInU112,
    uint256 _orderIntervals,
    uint256 _orderBlockInterval
  ) external returns (uint256 orderAmount, uint256 orderId) {
    // Determine selling rate based on number of blocks to expiry and total amount:
    //
    // #unchecked:
    //             Subtraction in assignment of lastExpiryBlock won't underflow because the
    //             block number will always be greater than the _orderBlockInterval on mainnet until
    //             it overflows in a very long time (suspect the universe may have collapsed by then).
    //
    //             Overflow not possible in the multiplication and addition of the assignment of
    //             orderExpiry in a reasonable time (i.e. universe may collapse first). Reason is
    //             that max(_orderIntervals) = STABLE_MAX_INTERVALS (18-bits), max(_orderBlockInterval) =
    //             DAILY_OBI (13-bits), which the product of maxes at 31-bits. Thus lastExpiryBlock
    //             is the dominant term when the block.number approaches (2**256 - 1) - (2**34 - 1).
    //
    //             Underflow not possible in assignment to tradeBlocks since orderExpiry always >
    //             block.number.
    uint256 lastExpiryBlock = block.number - (block.number % _orderBlockInterval);
    uint256 orderExpiry = _orderBlockInterval * (_orderIntervals + 1) + lastExpiryBlock; // +1 protects from div 0
    uint256 tradeBlocks = orderExpiry - block.number;
    uint256 sellingRateU112 = _amountInU112 / tradeBlocks; // Intended: Solidity rounds towards zero.
    requireErrCode(sellingRateU112 > 0, CronErrors.ZERO_SALES_RATE);

    // Update the current and ending sales rates state:
    //
    _incDecSalesRates(_virtualOrders, sellingRateU112, orderExpiry, _token0To1, true);

    // NOTE: Cast to uint112 below for sellingRateU112 is safe because _amountInU112 must be less than 112-bits
    //       as checked by Balancer and reverted with Balancer error BAL#526 BALANCE_TOTAL_OVERFLOW.
    // NOTE: Cast to uint128 below for unpackPairU128 is safe because the result of that function
    //       cannot execeed 128-bits (correct by construction, i.e. function pulls a 128-bit value from
    //       packed storage in 256-bit slot).
    // NOTE: scaledProceeds0 is measured in amount of Token 1 received for selling Token 0 from Order Pool 0
    //       to the AMM (and vice-versa scaledProceeds1).
    //
    // #overUnderFlowIntended
    //                        In the very distant future, the nextOrderId will overflow. Given the 5 year
    //                        order length limit, it's improbable that 2**256 -1 orders will occur and
    //                        result in the overwriting of an existing order:
    //
    //                            * Assume 12s blocks.
    //                            * Five years in seconds 157788000 (365.25d / year).
    //                            * Blocks in 5 years = 13149000.
    //                            * Conservatively overestimate 1000 orders per block,
    //                              then 13149000000 orders in 5 years.
    //                            * 34-bits used for 5 years, assuming an excessive number of orders per block.
    //                            * Caveat Emptor on those who do not withdraw their proceeds in
    //                              an insufficient amount of time from order start.
    orderId = _virtualOrders.nextOrderId++;
    _virtualOrders.orderMap[orderId] = Order(
      _token0To1,
      false,
      0,
      0,
      uint112(sellingRateU112),
      uint128(BitPackingLib.unpackU128(_virtualOrders.orderPools.scaledProceeds, _token0To1)),
      _sender,
      ((_sender != _delegate) ? _delegate : C.NULL_ADDR),
      orderExpiry,
      block.number
    );

    // Update order accounting (add the user's order amount to the global orders accounting):
    //
    // NOTE: The amount in (_amountInU112) is not the amount that will be swapped due to
    //       truncation. The amount that will be swapped is the number of blocks in the order
    //       multiplied by the order sales rate. The remainder is implicitly added to the pool
    //       reserves, augmenting LP rewards (Caveat Emptor Design Philosophy for Swap User).
    //
    // #unchecked
    //            Multiplication below is unchecked because sellingRate is maximum U112 and
    //            tradeBlocks is maximum U24 (STABLE_OBI * STABLE_MAX_INTERVALS = 13149000 blocks),
    //            the product of which will not overflow a U256. Also note the U112 limit is checked
    //            in the increment call.
    orderAmount = sellingRateU112 * tradeBlocks;
  }

  /// @notice Performs an extension of a long-term order to block intervals beyond the current
  ///         order expiry, based on the amount of token provided.
  ///         The extension is performed at the current order sales rate, thus the amount to extend
  ///         must be a product of the number of intervals to extend, the order block interval,
  ///         and the order sales rate. The extension amount can be comprised of externally provided
  ///         funds, funds stored in the order's deposit field, or both, so long as they add up to
  ///         at least one interval of extension amount (order-block-interval * order-sales-rate).
  ///         Any excess amount beyond integer multiples of this product are stored in the order's
  ///         deposit use for later use or refund to the user.
  ///         Attempts to extend an order with insufficient funds will result in the transaction
  ///         being reverted.
  ///         Orders cannot be extended when they are paused or when the pool is paused.
  ///         Importantly, extending an order does not execute virtual orders, reducing the gas
  ///         used by this operation.
  /// @param _slot1 is the current state of the pool's bit optimized storage slot 1, which is used
  ///               to efficiently store the orders accounting. The orders accounting needs to be
  ///               updated corresponding to the extend operation.
  /// @param _ops is the storage for the pool's order pool data, required to modify sales rates
  ///                corresponding to extending the order. See OrderPools struct documentation for
  ///                more details.
  /// @param _order is the storage data for the order to be extended. See Order struct
  ///               documentation for more details.
  /// @param _token0InU112 is the amount of Token 0 to extend the order with.
  ///                      Min. = 0, Max. = (2**112) - 1
  /// @param _token1InU112 is the amount of Token 1 to extend the order with.
  ///                      Min. = 0, Max. = (2**112) - 1
  /// @param _orderBlockInterval is the number of blocks in an Order Block Interval (OBI), and is
  ///                            expected to be one of the following values, as set in this pool:
  ///                                STABLE_OBI      (75 blocks)
  ///                                LIQUID_OBI     (300 blocks)
  ///                                VOLATILE_OBI  (1200 blocks)
  ///                                DAILY_OBI     (7200 blocks)
  /// @param _maxOrderIntervals is the maximum number of blocks permissible for an order from start
  ///                           to finish. It is expected to be one of the following values, as set
  ///                           in this pool:
  ///                                STABLE_MAX_INTERVALS    (175320 blocks)
  ///                                LIQUID_MAX_INTERVALS    (43830 blocks)
  ///                                VOLATILE_MAX_INTERVALS  (10957 blocks)
  ///                                DAILY_MAX_INTERVALS     (1825 blocks)
  /// @return slot1 updated state of the pool's bit optimized storage slot 1, specifically either
  ///               token 0 or 1 order amounts, corresponding to this extend operation.
  ///
  function longTermExtend(
    uint256 _slot1,
    OrderPools storage _ops,
    Order storage _order,
    uint256 _token0InU112,
    uint256 _token1InU112,
    uint256 _orderBlockInterval,
    uint256 _maxOrderIntervals
  ) external returns (uint256 slot1) {
    uint256 orderExpiry = _order.orderExpiry;
    requireErrCode(block.number < orderExpiry, CronErrors.INVALID_OR_EXPIRED_ORDER);
    requireErrCode(!_order.paused, CronErrors.PAUSED_ORDER);

    // Compute the new expiry interval based on the order sales rate, amount provided and order
    // deposit remaining:
    //
    bool token0To1 = _order.token0To1;
    requireErrCode(
      (token0To1 && _token1InU112 == 0) || (!token0To1 && _token0InU112 == 0),
      CronErrors.WRONG_ORDER_TOKEN_PROVIDED
    );
    uint256 inputAmount = (token0To1 ? _token0InU112 : _token1InU112);

    // TODO: #auditanalysis--why unchecked addition?
    uint256 extendAmount = inputAmount + _order.deposit;
    uint256 salesRate = _order.salesRate;
    // TODO: #auditanalysis--why unchecked addition?
    //                     --why no div0 check?
    uint256 maxNewExpiryBlock = orderExpiry + (extendAmount / salesRate);
    // TODO: #auditanalysis--why unchecked subtraction?
    //                     --why no mod0 check?
    uint256 newExpiryBlock = maxNewExpiryBlock - (maxNewExpiryBlock % _orderBlockInterval);

    requireErrCode((newExpiryBlock - orderExpiry) >= _orderBlockInterval, CronErrors.INSUFFICIENT_AMOUNT);

    // Ensure new order extension doesn’t exceed maximum length from original order start
    //
    requireErrCode(
      ((newExpiryBlock - _order.orderStart) / _orderBlockInterval) <= _maxOrderIntervals,
      CronErrors.MAX_ORDER_LENGTH_EXCEEDED
    );

    // Update order accounting (add the user's order amount to the global orders accounting):
    //
    slot1 = BitPackingLib.incrementPairU112(_slot1, (token0To1 ? inputAmount : 0), (token0To1 ? 0 : inputAmount));

    // Remove the current sales rate from the old sales rate ending at block:
    //
    _ops.salesRatesEndingPerBlock[orderExpiry] = BitPackingLib.decrementPairU112(
      _ops.salesRatesEndingPerBlock[orderExpiry],
      token0To1 ? salesRate : 0,
      token0To1 ? 0 : salesRate
    );

    // Add the current sales rate to the new sales rate ending at block:
    //
    _ops.salesRatesEndingPerBlock[newExpiryBlock] = BitPackingLib.incrementPairU112(
      _ops.salesRatesEndingPerBlock[newExpiryBlock],
      token0To1 ? salesRate : 0,
      token0To1 ? 0 : salesRate
    );

    // Store the remaining, unused deposit (sales) token for the user for refund/withdraw/later use:
    //
    // TODO: #auditanalysis--why unchecked subtraction?
    //                     --why unchecked multiplication?
    uint256 utilizedDeposit = (newExpiryBlock - orderExpiry) * salesRate;
    // TODO: #auditanalysis--why unchecked subtraction?
    _order.deposit = uint112(extendAmount - utilizedDeposit);

    // Update the order expiry information:
    //
    _order.orderExpiry = newExpiryBlock;
  }

  /// @notice Checks and stores balancer fee rates in slot 4 and also unpacks and clears accounting of
  ///         balancer fees for remittance by the pool contract through dueProtocolFeeAmountsU96.
  /// @param _slot4 is the current state of the pool's bit optimized storage slot 4, which is used
  ///               to efficiently store the balancer fee accounting. The fee accounting is updated
  ///               in this method and returned to the pool for writing to state.
  /// @param _protocolFeeDU1F18 the newest Balancer Fee passed into the pool by the onJoinPool and
  ///                           onExitPool functions. This number is divided by 1e18 (C.ONE_DU1_18) to
  ///                           arrive at a fee multiplier between 0 and 1, inclusive, with 18
  ///                           fractional decimal digits.
  ///                           Min. = 0, Max. = 10**18
  /// @return slot4 updated state of the pool's bit optimized storage slot 4, with updated values
  ///               for balancer fee accounting.
  /// @return dueProtocolFeeAmountsU96 the amount of Token 0 and Token 1 collected by the pool for
  ///                                  Balancer. Values are returned in the same array ordering that
  ///                                  IVault.getPoolTokens returns.
  ///                                  Min. = 0, Max. = (2**96) - 1
  ///
  function handleBalancerFees(uint256 _slot4, uint256 _protocolFeeDU1F18)
    external
    returns (uint256 slot4, uint256[] memory dueProtocolFeeAmountsU96)
  {
    if (_protocolFeeDU1F18 <= C.ONE_DU1_18) {
      uint256 currentBalancerFee = BitPackingLib.unpackBalancerFeeS4(_slot4);
      // #savegas: check before write
      if (currentBalancerFee != _protocolFeeDU1F18) {
        _slot4 = BitPackingLib.packBalancerFeeS4(_slot4, _protocolFeeDU1F18);
      }
    } else {
      // Ignore change and keep operating with old fee if new fee is too large but notify through logs.
      emit ProtocolFeeTooLarge(_protocolFeeDU1F18);
    }

    // Send the Balancer fees out of the pool and zero our accounting of them:
    dueProtocolFeeAmountsU96 = new uint256[](2);
    (slot4, dueProtocolFeeAmountsU96[C.INDEX_TOKEN0], dueProtocolFeeAmountsU96[C.INDEX_TOKEN1]) = BitPackingLib
      .unpackAndClearPairU96(_slot4);
  }

  /// @notice This function aids in performing a join given the amounts of Token 0 and Token 1 to add
  ///         to the pool along with the current virtual reserves and minimum prices to add the tokens
  ///         at. Specifically, this function performs the minimum price check and computes the pro-
  ///         -rata number of LP tokens provided in exchange for the tokens provided.
  /// @param _recipient is the account designated to receive pool shares in the form of LP tokens when
  ///                   Joining the pool. Can be set to _sender if sender wishes to receive the tokens
  ///                   and Join Events.
  /// @param _supplyLP is the supply of liquidity provider (LP) tokens for this pool.
  ///                  Min. = 0, Max. = (2**256) - 1
  /// @param _token0InU112 is the amount of Token 0 to Join the pool with.
  ///                      Min. = 0, Max. = (2**112) - 1
  /// @param _token1InU112 is the amount of Token 1 to Join the pool with.
  ///                      Min. = 0, Max. = (2**112) - 1
  /// @param _token0MinU112 is the minimum price of Token 0 permitted.
  ///                       Min. = 0, Max. = (2**112) - 1
  /// @param _token1MinU112 is the minimum price of Token 1 permitted.
  ///                       Min. = 0, Max. = (2**112) - 1
  /// @param _token0ReserveU112 is the current Token 0 reserves of the pool.
  ///                           Min. = 0, Max. = (2**112) - 1
  /// @param _token1ReserveU112 is the current Token 1 reserves of the pool.
  ///                           Min. = 0, Max. = (2**112) - 1
  /// @return amountLP is the amount of Liquidity Provider (LP) tokens returned in exchange for the
  ///                  amounts of Token 0 and Token 1 provided to the pool.
  function join(
    address _recipient,
    uint256 _supplyLP,
    uint256 _token0InU112,
    uint256 _token1InU112,
    uint256 _token0MinU112,
    uint256 _token1MinU112,
    uint256 _token0ReserveU112,
    uint256 _token1ReserveU112
  ) external pure returns (uint256 amountLP) {
    _joinMinimumCheck(
      _token0InU112,
      _token1InU112,
      _token0MinU112,
      _token1MinU112,
      _token0ReserveU112,
      _token1ReserveU112
    );

    requireErrCode(_recipient != C.NULL_ADDR, CronErrors.NULL_RECIPIENT_ON_JOIN);

    if (_supplyLP == 0) {
      requireErrCode(
        (_token0InU112 > C.MINIMUM_LIQUIDITY) && (_token1InU112 > C.MINIMUM_LIQUIDITY),
        CronErrors.INSUFFICIENT_LIQUIDITY
      );

      // #unchecked
      //            The check of _token0InU112 and _token1InU112 ensure that both are less
      //            than 112-bit maximums. Multiplying two 112-bit numbers will not exceed
      //            224-bits, hence no checked mul operator here.
      //            The check that both _token0InU112 and _token1InU112 exceed
      //            C.MINIMUM_LIQUIDITY, means that the square root of their product cannot
      //            be less than C.MINIMUM_LIQUIDITY, hence no checked sub operator here.
      amountLP = sqrt(_token0InU112 * _token1InU112) - C.MINIMUM_LIQUIDITY;
    } else {
      amountLP = Math.min(
        _token0InU112.mul(_supplyLP).divDown(_token0ReserveU112),
        _token1InU112.mul(_supplyLP).divDown(_token1ReserveU112)
      );
    }

    requireErrCode(amountLP > 0, CronErrors.INSUFFICIENT_LIQUIDITY);
  }

  /// @notice Increments or decrements the current sales rate and the sales rate
  ///         at the specified order expiry for the specified token.
  /// @param _virtualOrders is the storage for the pool's virtual order data,
  ///                       specifically used here to modify the order pool
  ///                       sales rate of the pool and the sales rate expiries
  ///                       of the pool.
  /// @param _salesRateU112 is the amount to increment or decrement the sales
  ///                       rates by.
  ///                       Min. = 0, Max. = (2**112) - 1
  /// @param _orderExpiry is the block number used to determine which index of
  ///                     the salesRatesEndingPerBlock mapping to increment or
  ///                     decrement.
  /// @param _token0To1 is a boolean indicating whether to adjust the sales rates
  ///                   of Token 0 if true, or Token 1 if false.
  /// @param _inc is a boolean indicating to increment sales rates when true or
  ///             decrement them otherwise.
  ///
  /// NOTE: This is a duplicate of the same named method in the pool contract,
  ///       with the exception of the _virtualOrders storage variable. It
  ///       appears here also as part of the effort to reduce contract size
  ///       when portions of the code where refactored to this library.
  ///
  function _incDecSalesRates(
    VirtualOrders storage _virtualOrders,
    uint256 _salesRateU112,
    uint256 _orderExpiry,
    bool _token0To1,
    bool _inc
  ) private {
    OrderPools storage ops = _virtualOrders.orderPools;

    uint256 token0SalesRateU112 = _token0To1 ? _salesRateU112 : 0;
    uint256 token1SalesRateU112 = _token0To1 ? 0 : _salesRateU112;

    uint256 salesRatesEndingPerBlock = ops.salesRatesEndingPerBlock[_orderExpiry];

    if (_inc) {
      ops.currentSalesRates = BitPackingLib.incrementPairU112(
        ops.currentSalesRates,
        token0SalesRateU112,
        token1SalesRateU112
      );
      ops.salesRatesEndingPerBlock[_orderExpiry] = BitPackingLib.incrementPairU112(
        salesRatesEndingPerBlock,
        token0SalesRateU112,
        token1SalesRateU112
      );
    } else {
      ops.currentSalesRates = BitPackingLib.decrementPairU112(
        ops.currentSalesRates,
        token0SalesRateU112,
        token1SalesRateU112
      );
      ops.salesRatesEndingPerBlock[_orderExpiry] = BitPackingLib.decrementPairU112(
        salesRatesEndingPerBlock,
        token0SalesRateU112,
        token1SalesRateU112
      );
    }
  }

  /// @notice Performs a check that minimum prices of tokens 0 and 1 are
  ///         satisfied within the pool, when joining. Protects against
  ///         sandwich attacks.
  /// @param _token0InU112 is the amount of Token 0 to Join the pool with.
  ///                      Min. = 0, Max. = (2**112) - 1
  /// @param _token1InU112 is the amount of Token 1 to Join the pool with.
  ///                      Min. = 0, Max. = (2**112) - 1
  /// @param _token0MinU112 is the minimum price of Token 0 permitted.
  ///                       Min. = 0, Max. = (2**112) - 1
  /// @param _token1MinU112 is the minimum price of Token 1 permitted.
  ///                       Min. = 0, Max. = (2**112) - 1
  /// @param _token0ReserveU112 is the current Token 0 reserves of the pool.
  ///                           Min. = 0, Max. = (2**112) - 1
  /// @param _token1ReserveU112 is the current Token 1 reserves of the pool.
  ///                           Min. = 0, Max. = (2**112) - 1
  ///
  function _joinMinimumCheck(
    uint256 _token0InU112,
    uint256 _token1InU112,
    uint256 _token0MinU112,
    uint256 _token1MinU112,
    uint256 _token0ReserveU112,
    uint256 _token1ReserveU112
  ) private pure {
    if (_token0ReserveU112 > 0 && _token1ReserveU112 > 0) {
      // #unchecked
      //            The multiplication below is unchecked for overflow because the product
      //            of two 112-bit values is less than 256-bits. (Reserves are correct by
      //            construction and Balancer ensures that the tokens in do not cause the
      //            pool to exceed 112-bits).
      uint256 nominalToken0 = (_token1InU112 * _token0ReserveU112) / _token1ReserveU112;
      uint256 nominalToken1 = (_token0InU112 * _token1ReserveU112) / _token0ReserveU112;
      requireErrCode(
        nominalToken0 >= _token0MinU112 && nominalToken1 >= _token1MinU112,
        CronErrors.MINIMUM_NOT_SATISFIED
      );
    }
  }
}
