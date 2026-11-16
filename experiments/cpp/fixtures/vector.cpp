#include <vector>

std::vector<int> numbers = {4, 1, 3};

int main() {
    numbers[0] = 2;
    numbers.push_back(5);
    numbers.pop_back();
    return numbers.size() == 3 && numbers[0] == 2 ? 0 : 1;
}
