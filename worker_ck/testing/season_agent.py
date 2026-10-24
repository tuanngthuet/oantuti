"""Small deterministic competitors for hosted testing; never imports engine internals."""
def agent(observation, configuration):
    player = observation['current_player']
    moves = observation['valid_moves']
    if not moves:
        raise ValueError('No legal action')
    # Filled by the harness for each participant; same source must be submitted anew each round.
    competitor = COMPETITOR
    stage = configuration['round']
    assert observation['finals']['engine_version'] == configuration['finals_rules']['engine_version']
    if (competitor + stage) % 3 == 0:
        cycle = ([{'from_col':1,'from_row':3,'to_col':0,'to_row':3}, {'from_col':0,'from_row':3,'to_col':1,'to_row':3}]
                 if player == 1 else
                 [{'from_col':7,'from_row':5,'to_col':8,'to_row':5}, {'from_col':8,'from_row':5,'to_col':7,'to_row':5}])
        choice = cycle[(observation['move_count']//2) % 2]
        for move in moves:
            if all(move[k] == v for k,v in choice.items()):
                return choice
    target = 8 if player == 1 else 0
    def score(move):
        distance = max(abs(move['to_col']-target),abs(move['to_row']-target))
        manhattan = abs(move['to_col']-target)+abs(move['to_row']-target)
        # Distinct tie preferences produce varied legal games and base captures.
        preference = (move['to_col']*(competitor+3) + move['to_row']*(stage+2)) % 7
        return -distance*100-manhattan*3+int(move.get('is_capture',False))*35+preference
    return max(moves,key=score)
