int dp[3][3] = {};

int main() {
    for (int row = 0; row < 3; ++row) {
        for (int col = 0; col < 3; ++col) {
            if (row == 0 || col == 0) {
                dp[row][col] = 1;
            } else {
                dp[row][col] = dp[row - 1][col] + dp[row][col - 1];
            }
        }
    }
    return dp[2][2] == 6 ? 0 : 1;
}
