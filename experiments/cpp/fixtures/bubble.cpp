int numbers[] = {7, 3, 5, 1};

void bubble(int (&a)[4]) {
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3 - i; ++j) {
            if (a[j] > a[j + 1]) {
                int temp = a[j];
                a[j] = a[j + 1];
                a[j + 1] = temp;
            }
        }
    }
}

int main() {
    bubble(numbers);
    return numbers[0] == 1 && numbers[3] == 7 ? 0 : 1;
}
