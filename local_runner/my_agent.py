# Đây là file duy nhất bạn cần sửa. Nhấn Ctrl+S để lưu rồi bấm Chạy thử.
# Không đổi tên hàm agent hoặc hai tham số bên dưới.
def agent(observation, configuration):
    # Engine đã tính sẵn tất cả nước đi hợp lệ cho bạn.
    moves = observation["valid_moves"]
    if not moves:
        return None

    # BẮT ĐẦU SỬA Ở ĐÂY: bản mẫu chọn nước đầu tiên.
    chosen_move = moves[0]
    # KẾT THÚC PHẦN CHỌN NƯỚC.

    return {
        "from_col": chosen_move["from_col"],
        "from_row": chosen_move["from_row"],
        "to_col": chosen_move["to_col"],
        "to_row": chosen_move["to_row"],
    }
