int answer = 0;

int factorial(int n) {
    if (n <= 1) {
        return 1;
    }
    return n * factorial(n - 1);
}

int main() {
    answer = factorial(5);
    return answer == 120 ? 0 : 1;
}
