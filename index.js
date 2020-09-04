const PORT = process.env.PORT || 7000;
const http = require('http').createServer().listen(PORT);
const io = require('socket.io')(http);
const {nanoid} = require('nanoid');
const shuffle = require('shuffle-array');
let waiting = new Map();//key:gameid value:roomID
let players = new Map();//key:socketid value:player
let roomInfos = new Map();//key:roomID

io.sockets.on('connection', function (socket) {

    //gameID: search among those who specify the same gameID
    //nickname: nickname
    socket.on('c2s_request-matching', function (param) {
        let gameID = param.gameID;
        let nickname = param.nickname;
        console.log('request-matching: ' + gameID + ' ' + nickname);
        if (gameID === undefined || nickname === undefined) {
            error(socket, 'please specify gameID and nickname');
            return;
        }

        let roomID;
        let room;
        if (waiting.has(gameID)) {
            //join existing room
            roomID = waiting.get(gameID);
            waiting.delete(gameID);
            room = roomInfos.get(roomID);
            io.to(socket.id).emit('s2c_joined-room',
                {
                    userList: room.players.map(player => player.nickname),
                    chatHistory: room.chatHistory
                }
            );//users' nicknames in the room (except oneself)
            //todo newcomer
        } else {
            roomID = nanoid();
            room = newRoom(roomID);
            roomInfos.set(roomID, room);
            waiting.set(gameID, roomID);
            io.to(socket.id).emit('s2c_created-room', {});
        }
        socket.join(roomID);
        let player = newPlayer(nickname, roomID, gameID, socket.id);
        console.log(player);
        players.set(socket.id, player);
        room.players.push(player);
        if (room.players.length === 2) {
            console.log('match!');
            initGame(socket);
        }
    });

    socket.on('c2s_chat', function (param) {
        console.log('chat' + param);
        let message = param.message;
        if (message === undefined) {
            error(socket, 'please specify message');
            return;
        }
        let room = roomOf(socket);
        if (room === undefined) {
            error(socket, 'you are not in any room');
            return;
        }

        let nickname = playerOf(socket).nickname;
        broadcast(socket, 's2c_chat', {from: nickname, message: message});
        room.chatHistory.push({from: nickname, message: message});
    });

    socket.on('c2s_play', function (param) {
        console.log('play' + JSON.stringify(param));
        if (roomOf(socket).turn !== playerOf(socket).turn) {
            error(socket, 'not your turn')
            return;
        }
        if (param.operation === undefined || param.next === undefined) {
            error(socket, 'please specify operation and next');
            return;
        }

        switch (operation) {
            case 'draw':
                draw(socket, param);
                break;
            case 'draw-expose':
                draw_expose(socket, param);
                break;
            case 'discard-expose':
                discard_expose(socket, param);
                break;
            case 'pass':
                pass(socket, param);
                break;
            default:
                error(socket, 'unknown operation');
                return;
        }
        room.turn = param.next;
    });

    socket.on('c2s_report-violation', function (param) {
        console.log('report-violation' + param);
        broadcast(socket, 's2c_report-violation', {message: param.message});
    });

    socket.on('disconnect', function () {
        let roomID = roomIDOf(socket);
        if (roomID === undefined) return;
        Array.prototype.forEach.call(
            io.of('/').in(roomID).clients,
            function (sid) {
                sid.leave(roomID);
                players.get(sid).roomID = undefined;
            });
        roomInfos.delete(roomID);
    });
});

function initGame(socket) {
    let room = roomOf(socket);
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

function playerOf(socket) {
    return players.get(socket.id);
}

function roomIDOf(socket) {
    if (player(socket) === undefined) return undefined;
    return player.roomID;
}

function roomOf(socket) {
    if (roomID(socket) === undefined) return undefined;
    return roomInfos.get(roomID);
}

function draw(socket, param) {
    let card = roomOf(socket).stock.shift();
    if (card === undefined) {
        error(socket, 'there are no cards on the stock')
        return;
    }

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

function draw_expose(socket, param) {
    let card = room.stock.shift();
    if (card === undefined) {
        error(socket, 'there are no cards on the stock')
        return;
    }

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
}

function discard_expose(socket, param) {
    card = param.card;
    if (card === undefined) {
        error(socket, 'please specify the card');
        return;
    }

    let player = playerOf(socket);
    //todo:一つだけ取り除く
    let newhand = player.hand.filter(n => n !== card);
    if (newhand.length === player.hand.length) {
        error(socket, 'you do not have the card');
        return;
    }
    player.hand = newhand;
    io.to(socket.id).emit(`s2c_discard-expose`, {});
    broadcast(socket, 's2c_discard-expose', {
        card: card,
        next: param.next,
        gameInfo: param.gameInfo
    });
}

function pass(socket, param) {
    io.to(socket.id).emit(`s2c_pass`, {});
    broadcast(socket, 's2c_pass', {
        next: param.next,
        gameInfo: param.gameInfl
    });
}

function error(socket, message) {
    io.to(socket.id).emit('s2c_error', {message: message});
}

function broadcast(socket, event, obj) {
    let roomID = players.get(socket.id).roomID;
    if (roomID === '' || roomID === undefined) {
        error(socket, 'you are not in any room');
        return false;
    }

    socket.broadcast.to(roomID).emit(event, obj);
    return true;
}

function newPlayer(nickname, roomID, gameID, socketID) {
    return {nickname: nickname, roomID: roomID, gameID: gameID, socketID: socketID, hand: [], turn: 0};
}

function newRoom(roomID) {
    return {players: [], stock: [], chatHistory: [], turn: 0, roomID: roomID};
}
