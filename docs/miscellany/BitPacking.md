# Solidity API

## BitPackingLib

Library for bit-packing generic and specific values pertinent to Cron-Fi TWAMM
        into storage-slots efficiently (both for gas use and contract size).

_Many custom representations are used herein (i.e. non native word lengths) and there
     are a number of explicit checks against the maximum of these non native word lengths.
     Furthermore there are unchecked operations (this code targets Solidity 0.7.x which
     didn't yet feature implicit arithmetic checks or have the 'unchecked' block feature)
     in this library for reasons of efficiency or desired overflow. Wherever they appear
     they will be documented and accompanied with one of the following tags:
       - #unchecked
       - #overUnderFlowIntended
     Identified risks will be accompanied and described with the following tag:
       - #RISK

Generic shifting methods were eschewed because of their additional gas use.
Conventions in the methods below are as follows:

     Suffixes:

     - The suffix of a variable name denotes the type contained within the variable.
       For instance "uint256 _incrementU96" is a 256-bit unsigned container representing
       a 96-bit value, _increment.
       In the case of "uint256 _balancerFeeDU1F18", the 256-bit unsigned container is
       representing a 19 digit decimal value with 18 fractional digits. In this scenario,
       the D=Decimal, U=Unsigned, F=Fractional.

     - The suffix of a function name denotes what slot it is proprietary too as a
       matter of convention. While unchecked at run-time or by the compiler, the naming
       convention easily aids in understanding what slot a packed value is stored within.
       For instance the function "unpackFeeShiftS3" unpacks the fee shift from slot 3. If
       the value of slot 2 were passed to this method, the unpacked value would be
       incorrect.

     Bit-Numbering:

     - Bits are counted starting with the least-significant bit (LSB) from 1. Thus for
       a 256-bit slot, the most-significant bit (MSB) is bit 256 and the LSB is bit 1.

     Offsets:

     - Offsets are the distance from the LSB to the desired LSB of the word being
       placed within a slot. For instance, to store an 8-bit word in a 256-bit slot
       at bits 16 down to 9, an offset of 8-bits should be specified.

     Pairs

     - The following methods which operate upon pairs follow the convention that a
       pair consists of two same sized words, with word0 stored above word1 within
       a slot. For example, a pair of 96-bit words will be stored with word0
       occupying bits 192 downto 97 and word1 occupying bits 96 downto 1. The following
       diagram depicts this scenario:

             bit-256     bit-192      bit-96      bit-1
                |           |            |           |
                v           v            v           v

          MSB < I    ???   II   word0   II   word1   I > LSB

                           ^            ^
                           |            |
                        bit-193      bit-97_

### packBit

```solidity
function packBit(uint256 _slot, uint256 _bitU1, uint256 _offsetU8) internal pure returns (uint256 slot)
```

Packs bit _bitU1 into the provided 256-bit slot, _slot, at location _offsetU8
        bits from the provided slot's LSB, bit 1.

_WARNING: No checks of _offsetU8 are performed for efficiency!_

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container to pack bit _bitU1 within. |
| _bitU1 | uint256 | A 1-bit value to pack into the provided slot.               Min. = 0, Max. = 1. |
| _offsetU8 | uint256 | The distance in bits from the provided slot's LSB to store _bitU1 at.                  Min. = 0, Max. = 255. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| slot | uint256 | The modified slot containing _bitU1 at bit position _offsetU8 + 1. |

### unpackBit

```solidity
function unpackBit(uint256 _slot, uint256 _offsetU8) internal pure returns (uint256 bitU1)
```

Unpacks bitU1 from the provided 256-bit slot, _slot, at location _offsetU8
        bits from the provided slot's LSB, bit 1.

_WARNING: No checks of _offsetU8 are performed for efficiency!_

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container to unpack bitU1 from. |
| _offsetU8 | uint256 | The distance in bits from the provided slot's LSB to unpack bitU1 from.                  Min. = 0, Max. = 255. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| bitU1 | uint256 | The 1-bit value unpacked from the provided slot.               Min. = 0, Max. = 1. |

### packU10

```solidity
function packU10(uint256 _slot, uint256 _wordU10, uint256 _offsetU8) internal pure returns (uint256 slot)
```

Packs ten-bit word, _wordU10, into the provided 256-bit slot, _slot, at location
        _offsetU8 bits from the provided slot's LSB, bit 1.

_WARNING: No checks of _offsetU8 are performed for efficiency!_

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container to pack bit _wordU10 within. |
| _wordU10 | uint256 | A ten-bit word to pack into the provided slot.                 Min. = 0, Max. = (2**10)-1. |
| _offsetU8 | uint256 | The distance in bits from the provided slot's LSB to store _bitU1 at.                  Min. = 0, Max. = 255. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| slot | uint256 | The modified slot containing _wordU10 at bit position _offsetU8 + 1. |

### unpackU10

```solidity
function unpackU10(uint256 _slot, uint256 _offsetU8) internal pure returns (uint256 wordU10)
```

Unpacks wordU10 from the provided 256-bit slot, _slot, at location _offsetU8
        bits from the provided slot's LSB, bit 1.

_WARNING: No checks of _offsetU8 are performed for efficiency!_

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container to unpack wordU10 from. |
| _offsetU8 | uint256 | The distance in bits from the provided slot's LSB to unpack wordU10 from.                  Min. = 0, Max. = 255. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| wordU10 | uint256 | The ten-bit word unpacked from the provided slot.                  Min. = 0, Max. = (2**10)-1. |

### incrementPairWithClampU96

```solidity
function incrementPairWithClampU96(uint256 _slot, uint256 _increment0U96, uint256 _increment1U96) internal pure returns (uint256 slot)
```

Increments the 96-bit words, word0 and/or word1, stored within the provided
        256-bit slot, _slot, by the values provided in _increment0U96 and _increment1U96
        respectively. Importantly, if the increment results in overflow, the value
        will "clamp" to the maximum value (2**96)-1.

_See the section on Pairs in the notes on Conventions to understand how the two
        words are stored within the provided slot._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container holding two 96-bit words, word0 and word1. |
| _increment0U96 | uint256 | The amount to increment word0 by.                       Min. = 0, Max. = (2**96)-1. |
| _increment1U96 | uint256 | The amount to increment word1 by.                       Min. = 0, Max. = (2**96)-1. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| slot | uint256 | The modified slot containing incremented values of word0 and/or word1. |

### unpackAndClearPairU96

```solidity
function unpackAndClearPairU96(uint256 _slot) internal pure returns (uint256 slot, uint256 word0U96, uint256 word1U96)
```

Unpacks the two 96-bit values, word0 and word1, from the provided slot, _slot,
        returning them along with the provided slot modified to clear the values
        or word0 and word1 to zero.

_See the section on Pairs in the notes on Conventions to understand how the two
        words are stored within the provided slot._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container holding two 96-bit words, word0 and word1. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| slot | uint256 | The modified slot containing cleared values of word0 and word1. |
| word0U96 | uint256 | The value of word0 prior to clearing it.                  Min. = 0, Max. = (2**96)-1. |
| word1U96 | uint256 | The value of word1 prior to clearing it.                  Min. = 0, Max. = (2**96)-1. |

### unpackPairU96

```solidity
function unpackPairU96(uint256 _slot) internal pure returns (uint256 word0U96, uint256 word1U96)
```

Unpacks and returns the two 96-bit values, word0 and word1, from the provided slot.

_See the section on Pairs in the notes on Conventions to understand how the two
        words are stored within the provided slot._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container holding two 96-bit words, word0 and word1. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| word0U96 | uint256 | The value of word0.                  Min. = 0, Max. = (2**96)-1. |
| word1U96 | uint256 | The value of word1.                  Min. = 0, Max. = (2**96)-1. |

### packPairU112

```solidity
function packPairU112(uint256 _slot, uint256 _word0U112, uint256 _word1U112) internal pure returns (uint256 slot)
```

Packs the two provided 112-bit words, word0 and word1, into the provided 256-bit
        slot, _slot.

_See the section on Pairs in the notes on Conventions to understand how the two
        words are stored within the provided slot._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container holding two 112-bit words, word0 and word1. |
| _word0U112 | uint256 | The value of word0 to pack.                   Min. = 0, Max. = (2**112)-1. |
| _word1U112 | uint256 | The value of word1 to pack.                   Min. = 0, Max. = (2**112)-1. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| slot | uint256 | The modified slot containing the values of word0 and word1. |

### unpackPairU112

```solidity
function unpackPairU112(uint256 _slot) internal pure returns (uint256 word0U112, uint256 word1U112)
```

Unpacks and returns the two 112-bit values, word0 and word1, from the provided slot.

_See the section on Pairs in the notes on Conventions to understand how the two
        words are stored within the provided slot._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container holding two 112-bit words, word0 and word1. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| word0U112 | uint256 | The value of word0.                  Min. = 0, Max. = (2**112)-1. |
| word1U112 | uint256 | The value of word1.                  Min. = 0, Max. = (2**112)-1. |

### incrementPairU112

```solidity
function incrementPairU112(uint256 _slot, uint256 _increment0U112, uint256 _increment1U112) internal pure returns (uint256 slot)
```

Increments the 112-bit words, word0 and/or word1, stored within the provided
        256-bit slot, _slot, by the values provided in _increment0U112 and _increment1U112
        respectively. Errors on overflow.

_See the section on Pairs in the notes on Conventions to understand how the two
        words are stored within the provided slot._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container holding two 112-bit words, word0 and word1. |
| _increment0U112 | uint256 | The amount to increment word0 by.                        Min. = 0, Max. = (2**112)-1. |
| _increment1U112 | uint256 | The amount to increment word1 by.                        Min. = 0, Max. = (2**112)-1. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| slot | uint256 | The modified slot containing incremented values of word0 and/or word1. |

### decrementPairU112

```solidity
function decrementPairU112(uint256 _slot, uint256 _decrement0U112, uint256 _decrement1U112) internal pure returns (uint256 slot)
```

Decrements the 112-bit words, word0 and/or word1, stored within the provided
        256-bit slot, _slot, by the values provided in _decrement0U112 and
        _decrement1U112 respectively. Errors on underflow.

_See the section on Pairs in the notes on Conventions to understand how the two
        words are stored within the provided slot._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container holding two 112-bit words, word0 and word1. |
| _decrement0U112 | uint256 | The amount to decrement word0 by.                        Min. = 0, Max. = (2**112)-1. |
| _decrement1U112 | uint256 | The amount to decrement word1 by.                        Min. = 0, Max. = (2**112)-1. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| slot | uint256 | The modified slot containing decremented values of word0 and/or word1. |

### unpackU128

```solidity
function unpackU128(uint256 _slot, bool _isWord0) internal pure returns (uint256 wordU128)
```

Unpacks and returns the specified 128-bit values, word0 or word1, from the provided slot,
        depending on the value of isWord0.

_See the section on Pairs in the notes on Conventions to understand how the two
        words are stored within the provided slot._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container holding two 128-bit words, word0 and word1. |
| _isWord0 | bool | Instructs this method to unpack the upper 128-bits corresponding to word0 when true.                 Otherwise the lower 128-bits, word1 are unpacked. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| wordU128 | uint256 | The value of word0.                  Min. = 0, Max. = (2**128)-1. |

### packPairU128

```solidity
function packPairU128(uint256 _word0U128, uint256 _word1U128) internal pure returns (uint256 slot)
```

Packs the two provided 128-bit words, word0 and word1, into a 256-bit slot.

_See the section on Pairs in the notes on Conventions to understand how the two
        words are stored within the slot._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _word0U128 | uint256 | The value of word0 to pack.                   Min. = 0, Max. = (2**128)-1. |
| _word1U128 | uint256 | The value of word1 to pack.                   Min. = 0, Max. = (2**128)-1. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| slot | uint256 | A slot containing the 128-bit values word0 and word1. |

### unpackPairU128

```solidity
function unpackPairU128(uint256 _slot) internal pure returns (uint256 word0U128, uint256 word1U128)
```

Unpacks and returns the two 128-bit values, word0 and word1, from the provided slot.

_See the section on Pairs in the notes on Conventions to understand how the two
        words are stored within the provided slot._

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container holding two 128-bit words, word0 and word1. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| word0U128 | uint256 | The value of word0.                   Min. = 0, Max. = (2**128)-1. |
| word1U128 | uint256 | The value of word1.                   Min. = 0, Max. = (2**128)-1. |

### packOracleTimeStampS2

```solidity
function packOracleTimeStampS2(uint256 _slot, uint256 _oracleTimeStampU32) internal pure returns (uint256 slot)
```

Packs the 32-bit oracle time stamp, _oracleTimeStampU32, into the provided 256-bit slot.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container to pack the oracle time stamp within. |
| _oracleTimeStampU32 | uint256 | The 32-bit oracle time stamp.                            Min. = 0, Max. = (2**32)-1. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| slot | uint256 | The modified slot containing the oracle time stamp. |

### unpackOracleTimeStampS2

```solidity
function unpackOracleTimeStampS2(uint256 _slot) internal pure returns (uint256 oracleTimeStampU32)
```

Unpacks the 32-bit oracle time stamp, oracleTimeStampU32, from the provided 256-bit slot,

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container to unpack the oracle time stamp from. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| oracleTimeStampU32 | uint256 | The 32-bit oracle time stamp.                            Min. = 0, Max. = (2**32)-1. |

### packFeeShiftS3

```solidity
function packFeeShiftS3(uint256 _slot, uint256 _feeShiftU3) internal pure returns (uint256 slot)
```

Packs the 3-bit fee shift, _feeShiftU3, into the provided 256-bit slot.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container to pack the fee shift into. |
| _feeShiftU3 | uint256 | The 3-bit fee shift.                    Min. = 0, Max. = 7. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| slot | uint256 | The modified slot containing the new fee shift value. |

### unpackFeeShiftS3

```solidity
function unpackFeeShiftS3(uint256 _slot) internal pure returns (uint256 feeShiftU3)
```

Unpacks the 3-bit fee shift, feeShiftU3, from the provided 256-bit slot,

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container to unpack the fee shift from. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| feeShiftU3 | uint256 | The 3-bit fee shift.                    Min. = 0, Max. = 7. |

### packBalancerFeeS4

```solidity
function packBalancerFeeS4(uint256 _slot, uint256 _balancerFeeDU1F18) internal pure returns (uint256 slot)
```

Packs the balancer fee, _balancerFeeDU1F18, into the provided 256-bit slot.

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container to pack the balancer fee into. |
| _balancerFeeDU1F18 | uint256 | The balancer fee representing a 19 decimal digit                           value with 18 fractional digits, NOT TO EXCEED 10**19.                           Min. = 0, Max. = 10**19. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| slot | uint256 | The modified slot containing the new balancer fee value. |

### unpackBalancerFeeS4

```solidity
function unpackBalancerFeeS4(uint256 _slot) internal pure returns (uint256 balancerFeeDU1F18)
```

Unpacks the 60-bit balancer fee representation, balancerFeeDU1F18, from the
        provided 256-bit slot,

#### Parameters

| Name | Type | Description |
| ---- | ---- | ----------- |
| _slot | uint256 | A 256-bit container to unpack the balancer fee from. |

#### Return Values

| Name | Type | Description |
| ---- | ---- | ----------- |
| balancerFeeDU1F18 | uint256 | The 60-bit balancer fee representing a 19 decimal digit value                           with 18 fractional digits.                           Min. = 0, Max. = (2**60)-1. |

