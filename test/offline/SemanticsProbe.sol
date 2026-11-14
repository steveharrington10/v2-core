// Test-only probe for the compiler-fork properties the core contracts rely on
// (32-byte addresses, unchecked 0.7.x arithmetic). Never deployed.
pragma solidity =0.7.6;

contract SemanticsProbe {
    // _update: uint32 timestamp delta must wrap.
    function sub32(uint32 a, uint32 b) external pure returns (uint32) {
        return a - b;
    }

    // price{0,1}CumulativeLast: uint256 += must wrap.
    function add256(uint a, uint b) external pure returns (uint) {
        return a + b;
    }

    // createPair salt: two full 32-byte words.
    function packAddresses(address a, address b) external pure returns (bytes memory) {
        return abi.encodePacked(a, b);
    }

    // periphery pairFor: address(uint(keccak256(...))) keeps all 32 bytes.
    function toAddress(bytes32 x) external pure returns (address) {
        return address(uint(x));
    }

    // createPair identity check and token sorting.
    function eqAddress(address a, address b) external pure returns (bool) {
        return a == b;
    }

    function ltAddress(address a, address b) external pure returns (bool) {
        return a < b;
    }

    // ABI decoding of address: the raw word, unmasked.
    function rawAddress(address a) external pure returns (bytes32 r) {
        assembly { r := a }
    }
}
