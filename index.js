const PORT = process.env.PORT || 7000;
const http = require('http').createServer().listen(PORT);
const io = require('socket.io')(http);
const {nanoid} = require('nanoid');
const shuffle = require('shuffle-array');
let waiting = new Map();//key:gameid value:socketid of waiting person
let players = new Map();//key:socketid value:player
let roomInfos = new Map();//key:room

io.sockets.on('connection', function (socket) {

    //gameID: search among those who specify the same gameID
    //nickname: nickname
    socket.on('c2s_request-matching', function (param) {
        console.log(param);
        let gameID = param.gameID;
        let nickname = param.nickname;
        console.log('request-matching: ' + gameID + ' ' + nickname);

        if (gameID === undefined || nickname === undefined) {
            error(socket.id, 'please specify gameID and nickname');
            return;
        }
        let roomID = '';
        if (waiting.has(gameID)) {
            //join existing room
            roomID = waiting.get(gameID);
            waiting.delete(gameID);
            console.log(roomInfos.get(roomID).players[0].nickname);
            io.to(socket.id).emit('s2c_joined-room',
                {
                    userList: roomInfos.get(roomID).players.map(player => player.nickname),
                    chatHistory: roomInfos.get(roomID).chatHistory
                }
            );//users' nicknames in the room (except oneself)
            //todo newcomer
        } else {
            roomID = nanoid();
            roomInfos.set(roomID, {players: [], stock: [], chatHistory: [], turn: 0, roomID: roomID});
            waiting.set(gameID, roomID);
            io.to(socket.id).emit('s2c_created-room', {});
        }
        socket.join(roomID);
        let player = {nickname: nickname, roomID: roomID, gameID: gameID, socketID: socket.id, hand: [], turn: 0};
        console.log(player);
        players.set(socket.id, player);
        roomInfos.get(roomID).players.push(player);

        if (roomInfos.get(roomID).players.length === 2) {
            console.log('match!');
            initGame(roomID);
        }
    });

    socket.on('c2s_chat', function (param) {
        console.log('chat' + param);
        let sid = socket.id;
        console.log(param);
        let message = param.message;
        if (message === undefined) {
            error(sid, 'please specify message');
            return;
        }
        let roomID = players.get(sid).roomID;
        if (roomID === '') {
            error(sid, 'you are not in any room');
            return;
        }
        let nickname = players.get(sid).nickname;
        broadcast(socket, 's2c_chat', {from: nickname, message: message});
        roomInfos.get(roomID).chatHistory.push({from: nickname, message: message});
    });

    socket.on('c2s_play', function (param) {
        console.log('play' + JSON.stringify(param));
        let sid = socket.id;
        let roomID = players.get(sid).roomID;
        let room = roomInfos.get(roomID);
        if (room.turn !== players.get(sid).turn) {
            error(sid, 'not your turn')
            return;
        }
        let operation = param.operation;
        if (operation === undefined || param.next === undefined) {
            error(sid, 'please specify operation and next');
            return;
        }
        switch (operation) {
            case 'draw':
            case 'draw-expose':
                let card = room.stock.shift();
                if (card === undefined) {
                    error('there are no cards on the stock')
                    return;
                }

                if (operation === 'draw-expose') {
                    io.to(sid).emit('s2c_draw-expose',
                        {
                            card: card
                        }
                    );
                    broadcast(socket, 's2c_draw-expose', {
                        card: card,
                        next: param.next,
                        gameInfo: param.gameInfo
                    });
                } else {
                    io.to(sid).emit('s2c_draw',
                        {
                            card: card
                        }
                    );
                    broadcast(socket, 's2c_draw', {
                        next: param.next,
                        gameInfo: param.gameInfo
                    });
                }
                break;
            case 'discard-expose':
                card = param.card;
                if (card === undefined) {
                    error('please specify the card');
                    return;
                }
                let turn = room.turn;
                let player = room.players[turn];
                //todo:一つだけ取り除く
                let newhand = player.hand.filter(n => n !== card);
                if (newhand.length === player.hand.length) {
                    error('you do not have the card');
                    return;
                }
                player.hand = newhand;
                io.to(sid).emit(`s2c_discard-expose`, {});
                broadcast(socket, 's2c_discard-expose', {
                    card: card,
                    next: param.next,
                    gameInfo: param.gameInfo
                });
                break;
            case 'pass':
                io.to(sid).emit(`s2c_pass`, {});
                broadcast(socket, 's2c_pass', {
                    next: param.next,
                    gameInfo: param.gameInfl
                });
                break;
            default:
                error(sid, 'unknown operation');
                return;
        }
        room.turn = param.next;
    });

    socket.on('c2s_report-violation', function (param) {
        console.log('report-violation' + param);
        broadcast(socket, 's2c_report-violation', {message: param.message});
    });

    socket.on('disconnect', function () {
        let player = players.get(socket.id);
        if (player === undefined) return;
        let roomID = player.roomID;
        if (roomID === undefined) return;
        Array.prototype.forEach.call(
            io.of('/').in(roomID).clients,
            function (sid) {
                sid.leave(roomID);
                players.get(sid).roomID = '';
            });
        roomInfos.delete(roomID);
    });
});

function initGame(roomID) {
    let room = roomInfos.get(roomID);
    console.log('before shuffle:' + JSON.stringify(room.players));
    shuffle(room.players);
    console.log('after shuffle:' + JSON.stringify(room.players));
    for (let i = 0; i < 52; i++) {
        room.stock.push(i);
    }
    shuffle(room.stock);
    console.log('stock:' + room.stock);
    room.players.forEach(function (player, idx) {
        let socketID = player.socketID;
        io.to(socketID).emit('s2c_game-start', {turn: idx});
        player.turn = idx;
    });
}

function error(sid, message) {
    io.to(sid).emit('s2c_error', {message: message});
}

function broadcast(socket, event, obj) {
    let roomID = players.get(socket.id).roomID;
    if (roomID === '' || roomID === undefined) {
        error(socket.id, 'you are not in any room');
        return false;
    }
    socket.broadcast.to(roomID).emit(event, obj);
}
