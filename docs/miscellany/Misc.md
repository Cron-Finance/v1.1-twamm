# Solidity API

## sqrt

```solidity
function sqrt(uint256 _value) internal pure returns (uint256 root)
```

Square-root function for providing initial liquidity.

_Sourced from Uniswap V2 library:
          - https://github.com/Uniswap/v2-core/blob/master/contracts/libraries/Math.sol
   Based on Babylonian Method:
          - https://en.wikipedia.org/wiki/Methods_of_computing_square_roots#Babylonian_method_

### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _value | uint256 | Is a number to approximate the square root of. |

### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| root | uint256 | The approximate square root of _value using the Babylonian Method. |

